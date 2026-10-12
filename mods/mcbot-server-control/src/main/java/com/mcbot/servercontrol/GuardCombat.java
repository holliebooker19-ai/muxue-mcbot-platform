package com.mcbot.servercontrol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponentType;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundPlayerActionPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.*;
import net.minecraft.world.entity.animal.AbstractGolem;
import net.minecraft.world.entity.animal.allay.Allay;
import net.minecraft.world.entity.decoration.ArmorStand;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.npc.Npc;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.entity.projectile.AbstractArrow;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.entity.projectile.ThrownPotion;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.*;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.pathfinder.PathType;
import net.minecraft.world.level.pathfinder.WalkNodeEvaluator;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Companion guard, ticked by a running follow: fight hostiles that come near the companion player instead of
 * only hitting back. Melee in reach, a bow at range (never through a player or a pet), a raised shield while
 * waiting for the swing or backing off, facing a bow drawn at it (or a projectile on its way) with the
 * shield up, and a retreat toward the player when health runs low. It runs (sprints) to a
 * foe and away from one, so a skeleton backing off cannot keep it at bow range. It never chases
 * beyond the leash around the player; when nothing needs fighting the follow carries on as before.
 */
final class GuardCombat {
    static final double MELEE_RANGE=3.2,BOW_MIN=4,BOW_CHASE=8,BOW_MAX=24,BOOM_SAFE=5,RETREAT_SPAN=5;
    /** Running away from a lit creeper: blocks per tick the body can count on (sprinting is about 0.28, minus start-up and turns) and the blocks to spare beyond the blast. */
    static final double RUN_SPEED=0.2,RUN_MARGIN=1;
    /** Ticks a raised shield needs before it blocks: vanilla LivingEntity.isBlocking() wants the shield in use for 5 ticks. */
    static final int SHIELD_DELAY=5;
    /**
     * How far ahead a shield has to go up: twice the delay. Read where a lit creeper is judged (lastMoment: ticks before it
     * goes off, when the body stops running and shields) and where a projectile is (shieldAgainstRanged: ticks before it arrives).
     */
    static final int SHIELD_LEAD=2*SHIELD_DELAY;
    /** One server tick in milliseconds, the unit of View.now(). */
    static final long TICK_MS=50;
    /** How long the shield stays up once nothing is aimed at the body any more: long enough for a raise to ever block, which also rides over a bow drawn and lowered again. */
    static final long SHIELD_HOLD_MS=SHIELD_DELAY*TICK_MS;
    /** Vanilla's margin around a target's box when an arrow's flight is tested against it, and the drag and gravity it flies under (per tick, after the move). */
    static final double HIT_MARGIN=0.3,ARROW_DRAG=0.99,ARROW_GRAVITY=0.05;
    /** Moving to where an arrow can reach: the ring of spots tried, the walk and search timings, and how often one fight may do it. */
    static final double SPOT_ARRIVE=1.2,SPOT_EDGE=1.5;
    static final long SPOT_COOLDOWN_MS=1000,SPOT_WALK_MS=6000;
    static final int SPOT_RINGS=4,SPOT_MAX_CHECKED=24,SPOT_MAX_PER_FIGHT=6;
    static final int FULL_DRAW=20,MAX_DRAW=80;
    static final long NO_PATH_MS=5000,STALE_FIGHT_MS=15000,KILL_WINDOW_MS=3000;
    record Options(double radius,double leash,float lowHealth,boolean bow,boolean shield) {
        static Options parse(JsonElement value) {
            if(value==null||value.isJsonNull())return null;
            if(value.isJsonPrimitive()&&value.getAsJsonPrimitive().isBoolean())return value.getAsBoolean()?parse(new JsonObject()):null;
            if(!value.isJsonObject())throw error("INVALID_ARGUMENT","guard must be a boolean or an object");
            JsonObject args=value.getAsJsonObject();
            double radius=bounded(args,"radius",8,3,12);
            float low=(float)bounded(args,"lowHealth",8,4,16);
            boolean bow=!args.has("bow")||bool(args,"bow"),shield=!args.has("shield")||bool(args,"shield");
            return new Options(radius,Math.min(16,radius+4),low,bow,shield);
        }
        JsonObject json(){return obj("radius",radius,"leash",leash,"lowHealth",lowHealth,"bow",bow,"shield",shield);}
    }
    /** One living thing worth fighting, with the native facts the decisions need. */
    record Foe(Object identity,String id,String type,Vec3 position,double distance,double companionDistance,
               boolean targetingCompanion,boolean targetingSelf,boolean ranged,boolean creeper,boolean explosionPreparing,boolean flying,boolean visible,
               int fuse,double blast,boolean charging) {
        /**
         * fuse: ticks until a swelling creeper explodes (-1 unknown); blast: how far its explosion hurts, in blocks (0 unknown);
         * charging: a bow (or trident) in use, or a crossbow held loaded, with the body as its target (the mob's own target,
         * not "recently hurt by"). One aimed at the player is not: the body's shield cannot cover them, so it goes for the foe.
         */
        Foe(Object identity,String id,String type,Vec3 position,double distance,double companionDistance,
            boolean targetingCompanion,boolean targetingSelf,boolean ranged,boolean creeper,boolean explosionPreparing,boolean flying,boolean visible,
            int fuse,double blast) {
            this(identity,id,type,position,distance,companionDistance,targetingCompanion,targetingSelf,ranged,creeper,explosionPreparing,flying,visible,fuse,blast,false);
        }
        Foe(Object identity,String id,String type,Vec3 position,double distance,double companionDistance,
            boolean targetingCompanion,boolean targetingSelf,boolean ranged,boolean creeper,boolean explosionPreparing,boolean flying,boolean visible) {
            this(identity,id,type,position,distance,companionDistance,targetingCompanion,targetingSelf,ranged,creeper,explosionPreparing,flying,visible,-1,0,false);
        }
    }
    /** A projectile a shield can stop that will enter the body's box: where it is now and in how many ticks (1 is the next move). */
    record Incoming(Object identity,Vec3 position,int ticks) {}
    interface View {
        long now();
        Vec3 position();
        float health();
        /** Eligible foes only: hostile or attacking the companion or the body, never a player or a pet. */
        List<Foe> foes(Vec3 companion,double radius);
        boolean dead(Foe foe);
        boolean inReach(Foe foe);
        /** One walking tick toward melee reach, staying within the leash; throws when there is no way. */
        boolean approach(Foe foe,Vec3 companion,double leash);
        /** One walking tick toward a safer spot, staying within the leash; throws when there is no way. */
        boolean retreat(Vec3 destination,Vec3 companion,double leash);
        void stopMoving();
        /** Best verified melee weapon (or a bare hand, after stowing what is held) selected; false when nothing safe can be held. */
        boolean armMelee();
        boolean cooledDown();
        /** Confirmed damage of one native attack on exactly this foe. */
        float attack(Foe foe);
        boolean hasBow();
        boolean armBow();
        /**
         * An arrow can reach the foe: flown tick by tick (it arcs and drops), it meets the foe before any block, and no
         * player, pet or villager is near its path. Tries the middle of the foe, then higher up (a foe behind a block
         * edge may show only its head), and aims at the first that works.
         */
        boolean clearShot(Foe foe);
        /**
         * The first of `candidates` (nearest first) a walker can stand on, without a fall of more than a block, from which
         * an arrow reaches the foe the same way clearShot checks it; null when none. Costly: the caller rations it.
         */
        Vec3 shootingSpot(Foe foe,List<Vec3> candidates);
        /** One walking tick to `spot`, staying within `limit` of the companion; true once there; throws when there is no way. */
        boolean reposition(Vec3 spot,Vec3 companion,double limit);
        /** Ticks the bow has been drawn, or -1. */
        int drawing();
        void draw(Foe foe);
        void release(Foe foe);
        void cancelDraw();
        boolean armShield();
        void raiseShield(Foe foe);
        /** Face `point` with the shield up (a projectile has no foe to look at). */
        void raiseShieldAt(Vec3 point);
        void lowerShield();
        /** Projectiles that will enter the body's box within `ticks` ticks and that a shield can stop (not the body's own, a player's or a friend's), soonest first. */
        List<Incoming> incoming(int ticks);
    }
    private final View view;
    private final GuardExecution execution;
    final Options options;
    private Foe target,lastHitFoe;
    private String state="idle";
    private final Map<Object,Long> noPath=new HashMap<>();
    private boolean retreating;
    /** Why the last melee could not start: the hand could not be emptied (NO_FREE_HAND); cleared once a hand is ready. */
    private String unarmed;
    private long engagedAt,lastHitAt;
    private int hits,kills,shots,retreats;
    private double damage;
    /**
     * Why the bow does not shoot, for the guard state and the server log: bow draws begun, why the last fight ended
     * (lastEnd) and why the last draw was lowered before the arrow left (lastDrop). Nothing here decides anything.
     */
    private int draws,fightDraws,fightShots;
    private String lastEnd,lastDrop;
    /** Shield holds begun (any reason) and why the last one was not possible (OFF, NO_SHIELD); diagnosis only. */
    private int shields;
    private boolean shielded;
    private String lastShield;
    /** What the shield is up against while it is held for a ranged threat (RANGED: a bow drawn or a crossbow loaded at the body, PROJECTILE: something in flight), else null; and when a threat was last seen. */
    private String holdWhy;
    private long threatAt=Long.MIN_VALUE/2;
    /** The lit creeper the body found no way to run from (its retreat was refused): shield instead of trying again. */
    private Object cornered;
    /** Where the body is walking to for a shot, since when, the earliest next search, tries this fight, spots that had no way, and how the last try ended; the count is diagnosis. */
    private Vec3 spot;
    private long spotSince,spotAfter;
    private int fightSpots,repositions;
    private final List<Vec3> badSpots=new ArrayList<>();
    private String lastReposition;
    private long loggedAt=Long.MIN_VALUE/2;
    private static final org.slf4j.Logger LOGGER=com.mojang.logging.LogUtils.getLogger();
    GuardCombat(View view,Options options){this(view,options,new GuardExecution(()->true));}
    private GuardCombat(View view,Options options,GuardExecution execution){this.view=view;this.options=options;this.execution=execution;}
    String state(){return state;}
    JsonObject json() {
        JsonObject result=obj("state",state,"hits",hits,"damage",damage,"shots",shots,"kills",kills,"retreats",retreats,"draws",draws,"shields",shields,"repositions",repositions,"options",options.json());
        if(lastShield!=null)result.addProperty("lastShield",lastShield);
        if(holdWhy!=null)result.addProperty("blocking",holdWhy);
        if(lastReposition!=null)result.addProperty("lastReposition",lastReposition);
        if(lastEnd!=null)result.addProperty("lastEnd",lastEnd);
        if(lastDrop!=null)result.addProperty("lastDrop",lastDrop);
        if(target!=null){result.addProperty("target",target.type());result.addProperty("targetId",target.id());}
        if(unarmed!=null)result.addProperty("unarmed",unarmed);
        return result;
    }
    /** Whether anything around the player is a foe this guard would fight: the same search, centre and radius as a tick. */
    boolean foesNear(Vec3 companion){return !view.foes(companion,options.radius()).isEmpty();}
    /** True when the guard drove the body this tick; false leaves the tick to the ordinary follow. */
    boolean tick(Vec3 companion) {
        var permission=execution.capture();
        if(!permission.getAsBoolean())return false;
        try {return tick(companion,permission)&&permission.getAsBoolean();}
        catch(Protocol.Error failure){if(!permission.getAsBoolean())return false;throw failure;}
    }
    private static void requireDrive(java.util.function.BooleanSupplier permission){if(!permission.getAsBoolean())throw error("CANCELLED","Guard execution was interrupted");}
    private boolean tick(Vec3 companion,java.util.function.BooleanSupplier permission) {
        long now=view.now();
        noPath.values().removeIf(at->now-at>NO_PATH_MS);
        if(lastHitFoe!=null) {
            if(view.dead(lastHitFoe)){kills++;lastHitFoe=null;}
            else if(now-lastHitAt>KILL_WINDOW_MS)lastHitFoe=null;
        }
        List<Foe> foes=view.foes(companion,options.radius());
        Foe nearest=foes.stream().min(Comparator.comparingDouble(Foe::distance)).orElse(null);
        float health=view.health();
        if(!retreating&&health<=options.lowHealth()&&nearest!=null&&nearest.distance()<=8){retreating=true;retreats++;}
        else if(retreating&&health>=options.lowHealth()+4)retreating=false;
        Foe boom=foes.stream().filter(f->f.explosionPreparing()&&f.distance()<Math.max(BOOM_SAFE,f.blast())).min(Comparator.comparingDouble(Foe::distance)).orElse(null);
        if(boom!=null||retreating) {
            Foe from=boom!=null?boom:nearest;
            if(from==null||from.distance()>12){settle("FOE_FAR");return false;}
            spot=null;
            // A lit creeper the body cannot outrun: stand still, face it and let the shield take the blast. Otherwise run, as before.
            // canOutrun only measures open ground; walls and pits are found by trying, so a refused retreat or a fuse about to run out inside the blast also means shield.
            boolean stuck=boom!=null&&(boom.identity()==cornered||lastMoment(view.position(),boom.position(),boom.blast(),boom.fuse()));
            if(boom!=null&&(stuck||!canOutrun(view.position(),boom.position(),companion,options.leash(),boom.blast(),boom.fuse()))&&holdShield(boom,permission)){state="shielding";return true;}
            backOff(from,companion,boom!=null&&!retreating?"evading":"retreating",boom==null||retreating,permission);
            return true;
        }
        // After the creeper (a blast is worse than an arrow), before choosing whom to fight: a bow drawn or a loaded crossbow at the body, or a projectile about to arrive.
        if(shieldAgainstRanged(foes,now,permission)){state="shielding";return true;}
        Foe chosen=choose(foes);
        if(chosen==null){settle("NO_FOE");return false;}
        if(target==null||target.identity()!=chosen.identity()){engagedAt=now;spot=null;badSpots.clear();fightSpots=0;}
        target=chosen;
        // A fight that lands nothing for a long time (the foe hides behind a wall, keeps out of reach) is let go.
        if(now-engagedAt>STALE_FIGHT_MS&&now-Math.max(lastHitAt,engagedAt)>STALE_FIGHT_MS){noPath.put(chosen.identity(),now);settle("STALE");return false;}
        boolean melee=chosen.distance()<=MELEE_RANGE&&view.inReach(chosen);
        int drawn=view.drawing();
        if(!melee&&shouldShoot(chosen,drawn>=0)&&view.armBow()) {
            requireDrive(permission);if(spot==null)view.stopMoving();lower();
            if(!view.clearShot(chosen)) {
                // Not reachable from here (a ledge underfoot, a wall corner): walk to a spot where an arrow does reach.
                if(spot!=null||findSpot(chosen,companion,now)){walkToSpot(chosen,companion,now);requireDrive(permission);state="repositioning";return true;}
                // Hold the draw while someone stands in the way; give up only after a long wait.
                if(drawn>=0&&drawn<MAX_DRAW)view.draw(chosen);else drop("NO_CLEAR_SHOT");
                requireDrive(permission);state="aiming";return true;
            }
            if(spot!=null){spot=null;view.stopMoving();lastReposition="CLEAR";}
            if(drawn<0){view.draw(chosen);draws++;}
            else if(drawn>=FULL_DRAW){view.release(chosen);shots++;lastHitFoe=chosen;lastHitAt=now;}
            else view.draw(chosen);
            requireDrive(permission);state="shooting";return true;
        }
        spot=null;
        requireDrive(permission);drop(melee?"MELEE":!chosen.visible()?"NOT_VISIBLE":chosen.distance()<=MELEE_RANGE?"CLOSE":"NOT_BOW_TARGET");
        if(melee) {
            view.stopMoving();
            if(!view.armMelee()){unarmed="NO_FREE_HAND";noPath.put(chosen.identity(),now);settle("NO_FREE_HAND");return false;}
            unarmed=null;
            requireDrive(permission);
            if(view.cooledDown()) {
                lower();
                float dealt=view.attack(chosen);
                if(dealt>0){hits++;damage+=dealt;lastHitFoe=chosen;lastHitAt=now;}
            } else if(options.shield()&&(chosen.targetingSelf()||chosen.charging())&&view.armShield()){requireDrive(permission);raise(chosen);}
            else lower();
            requireDrive(permission);state="fighting";return true;
        }
        if(chosen.flying()){settle("FLYING");return false;} // nothing to walk to; wait for it to swoop into reach
        lower();
        try {view.approach(chosen,companion,options.leash());}
        catch(Protocol.Error blocked){noPath.put(chosen.identity(),now);view.stopMoving();settle("NO_PATH");return false;}
        requireDrive(permission);state="approaching";return true;
    }
    private boolean shouldShoot(Foe foe,boolean drawing) {
        if(!options.bow()||!foe.visible()||foe.distance()>BOW_MAX||!view.hasBow())return false;
        if(drawing)return foe.distance()>MELEE_RANGE;
        if(foe.distance()<BOW_MIN)return false;
        return foe.ranged()||foe.creeper()||foe.flying()||noPath.containsKey(foe.identity())||foe.distance()>=BOW_CHASE;
    }
    /** Keep the current foe while it is still eligible; otherwise whoever threatens the companion first, then the nearest. */
    private Foe choose(List<Foe> foes) {
        boolean bow=options.bow()&&view.hasBow();
        List<Foe> able=foes.stream().filter(f->!noPath.containsKey(f.identity())||bow&&f.visible()).toList();
        if(target!=null)for(Foe foe:able)if(foe.identity()==target.identity())return foe;
        return able.stream().min(Comparator.comparing((Foe f)->!f.targetingCompanion()).thenComparing(f->!f.targetingSelf()).thenComparingDouble(Foe::companionDistance)).orElse(null);
    }
    /** shield: raise it while backing off (low health); running from a creeper that can be outrun goes without, since a body using an item does not sprint. */
    private void backOff(Foe from,Vec3 companion,String next,boolean shield,java.util.function.BooleanSupplier permission) {
        drop(next.toUpperCase(java.util.Locale.ROOT));target=null;spot=null;
        if(shield&&options.shield()&&view.armShield()){requireDrive(permission);raise(from);}
        else lower();
        requireDrive(permission);
        try {view.retreat(retreatPoint(view.position(),from.position(),companion,options.leash()),companion,options.leash());}
        catch(Protocol.Error blocked){view.stopMoving();if(next.equals("evading"))cornered=from.identity();}
        requireDrive(permission);state=next;
    }
    /** Toward the player when that is away from the foe; otherwise straight away from it, kept inside the leash. */
    static Vec3 retreatPoint(Vec3 feet,Vec3 foe,Vec3 companion,double leash) {
        Vec3 flatFoe=new Vec3(foe.x,feet.y,foe.z),flatCompanion=new Vec3(companion.x,feet.y,companion.z);
        if(flatCompanion.distanceTo(flatFoe)>feet.distanceTo(flatFoe)+1)return companion;
        Vec3 away=feet.subtract(flatFoe);
        if(away.horizontalDistance()<0.001)away=new Vec3(1,0,0);
        Vec3 point=feet.add(new Vec3(away.x,0,away.z).normalize().scale(RETREAT_SPAN));
        Vec3 leashed=point.subtract(flatCompanion);
        return leashed.horizontalDistance()<=leash-1?point:flatCompanion.add(new Vec3(leashed.x,0,leashed.z).normalize().scale(leash-1));
    }
    private void settle(String why){drop(why);lower();target=null;spot=null;state="idle";ended(why);}
    void stop(){execution.interrupt();try{drop("INTERRUPTED");lower();}finally{view.stopMoving();target=null;spot=null;state="idle";ended("INTERRUPTED");}}
    private void raise(Foe from){view.raiseShield(from);raised();holdWhy=null;}
    private void raised(){if(!shielded){shielded=true;shields++;}}
    private void lower(){view.lowerShield();shielded=false;holdWhy=null;}
    /**
     * A bow drawn (or a trident, or a loaded crossbow) at the body, or a projectile that reaches the body in
     * time to be blocked: stand still, put the bow down and face it with the shield up, then keep it up for SHIELD_HOLD_MS after
     * the last sighting. Not with a foe already in reach: the swing comes first (and the melee branch shields between swings).
     * No shield, or shield:false: nothing here, the fight goes on as before, with the reason in lastShield.
     */
    private boolean shieldAgainstRanged(List<Foe> foes,long now,java.util.function.BooleanSupplier permission) {
        boolean engaged=foes.stream().anyMatch(f->f.distance()<=MELEE_RANGE&&view.inReach(f));
        Foe aimer=engaged?null:foes.stream().filter(f->f.charging()&&f.visible()).min(Comparator.comparingDouble(Foe::distance)).orElse(null);
        if(!options.shield()){if(aimer!=null)lastShield="OFF";return false;}
        // A raise only helps if it is up by the time the projectile arrives; one already up is kept.
        Incoming shot=engaged?null:view.incoming(SHIELD_LEAD).stream().filter(i->shielded||i.ticks()>=SHIELD_DELAY).findFirst().orElse(null);
        boolean threat=aimer!=null||shot!=null;
        if(threat)threatAt=now;
        else if(engaged||holdWhy==null||!shielded||now-threatAt>=SHIELD_HOLD_MS)return false;
        if(threat&&!view.armShield()){lastShield="NO_SHIELD";return false;}
        requireDrive(permission);
        drop("SHIELD");view.stopMoving();
        if(shot!=null){view.raiseShieldAt(shot.position());raised();holdWhy="PROJECTILE";}
        else if(aimer!=null){view.raiseShield(aimer);raised();holdWhy="RANGED";}
        if(threat)lastShield=null;
        return true;
    }
    /**
     * Face the foe with the shield up and stay put (an explosion hurts less from behind a shield, and only when the blast
     * comes from the front). The bow is put down first: a drawn bow and a raised shield are the same use of a hand.
     */
    private boolean holdShield(Foe from,java.util.function.BooleanSupplier permission) {
        if(!options.shield()){lastShield="OFF";return false;}
        drop("SHIELD");target=null;
        if(!view.armShield()){lastShield="NO_SHIELD";return false;}
        requireDrive(permission);
        view.stopMoving();raise(from);
        lastShield=null;
        return true;
    }
    /** Still inside the blast with the fuse nearly out: running on will not get clear in time, a shield raised now still will. Unknown fuse: no. */
    static boolean lastMoment(Vec3 feet,Vec3 foe,double blast,int fuse) {
        return fuse>=0&&fuse<=SHIELD_LEAD&&Math.hypot(feet.x-foe.x,feet.z-foe.z)<Math.max(blast,BOOM_SAFE);
    }
    /** Whether running from a lit creeper gets the body out of its blast before it goes off: `fuse` ticks of running, within the leash around the player; unknown fuse counts as yes. */
    static boolean canOutrun(Vec3 feet,Vec3 foe,Vec3 companion,double leash,double blast,int fuse) {
        if(fuse<0)return true;
        double range=Math.max(blast,BOOM_SAFE)+RUN_MARGIN;
        Vec3 flatFoe=new Vec3(foe.x,feet.y,foe.z);
        if(feet.distanceTo(flatFoe)>=range)return true;
        Vec3 goal=retreatPoint(feet,foe,companion,leash);
        double dx=goal.x-feet.x,dz=goal.z-feet.z,length=Math.sqrt(dx*dx+dz*dz);
        if(length<0.001)return false;
        dx/=length;dz/=length;
        // How far along that line the player's leash lets the body go (one block in from its edge, like retreatPoint).
        double rx=feet.x-companion.x,rz=feet.z-companion.z,edge=leash-1,b=rx*dx+rz*dz,c=rx*rx+rz*rz-edge*edge;
        double room=c>0?0:-b+Math.sqrt(b*b-c);
        double run=Math.min(RUN_SPEED*fuse,Math.max(0,room));
        return Math.hypot(feet.x+dx*run-foe.x,feet.z+dz*run-foe.z)>=range;
    }
    /** The rim of where the body may stand for a shot: inside the leash and inside the range at which the guard still takes the body from the player (GuardDuty.ENGAGE_RANGE is measured from the body to the player), with room to spare. */
    static double spotLimit(Options options){return Math.min(options.leash(),GuardDuty.ENGAGE_RANGE)-SPOT_EDGE;}
    /**
     * Spots a body could step to for a better shot, nearest first: rings of 1 to 4 blocks around its feet, eight ways, that
     * keep inside `limit` of the player, stay between BOW_MIN and BOW_MAX from the foe (closer would switch to melee) and are
     * not near a spot that already had no way. Where a block can be stood on is the view's business.
     */
    static List<Vec3> repositionCandidates(Vec3 feet,Vec3 foe,Vec3 companion,double limit,List<Vec3> avoid) {
        List<Vec3> result=new ArrayList<>();
        for(int ring=1;ring<=SPOT_RINGS;ring++)for(int way=0;way<8;way++) {
            double angle=way*Math.PI/4;
            Vec3 point=new Vec3(feet.x+Math.cos(angle)*ring,feet.y,feet.z+Math.sin(angle)*ring);
            double toFoe=Math.hypot(point.x-foe.x,point.z-foe.z);
            if(point.distanceTo(companion)>limit||toFoe<BOW_MIN||toFoe>BOW_MAX)continue;
            if(avoid.stream().anyMatch(bad->Math.hypot(bad.x-point.x,bad.z-point.z)<1.0))continue;
            result.add(point);
        }
        return result;
    }
    /** Look for a spot to shoot from, at most once per cooldown and a few times per fight; records why not. */
    private boolean findSpot(Foe foe,Vec3 companion,long now) {
        if(now<spotAfter)return false;
        spotAfter=now+SPOT_COOLDOWN_MS;
        if(fightSpots>=SPOT_MAX_PER_FIGHT){lastReposition="LIMIT";return false;}
        List<Vec3> candidates=repositionCandidates(view.position(),foe.position(),companion,spotLimit(options),badSpots);
        Vec3 found=candidates.isEmpty()?null:view.shootingSpot(foe,candidates);
        if(found==null){lastReposition=candidates.isEmpty()?"NO_CANDIDATE":"NO_SPOT";return false;}
        spot=found;spotSince=now;fightSpots++;repositions++;lastReposition="WALKING";
        return true;
    }
    /** One step toward the chosen spot; gives it up when there is no way or it takes too long. */
    private void walkToSpot(Foe foe,Vec3 companion,long now) {
        drop("REPOSITION");
        try {
            boolean there=view.reposition(spot,companion,spotLimit(options));
            if(there||view.position().distanceTo(spot)<=SPOT_ARRIVE){spot=null;view.stopMoving();lastReposition="ARRIVED";}
            else if(now-spotSince>SPOT_WALK_MS){badSpots.add(spot);spot=null;view.stopMoving();lastReposition="TIMEOUT";}
        } catch(Protocol.Error blocked) {
            badSpots.add(spot); // only that spot is out of reach, not the foe: it can still be shot from elsewhere or fought
            spot=null;view.stopMoving();lastReposition="NO_PATH";
        }
    }
    /** Lower a drawn bow, remembering why. */
    private void drop(String why){if(view.drawing()>=0)lastDrop=why;view.cancelDraw();}
    /** A fight is over: one log line (at most every 10 s) when the bow was drawn and no arrow left. */
    private void ended(String why) {
        lastEnd=why;
        if(draws>fightDraws&&shots==fightShots) {
            long now=view.now();
            if(now-loggedAt>=10_000){loggedAt=now;LOGGER.info("MCBOT guard: drew the bow {} times without loosing an arrow; the fight ended: {}; last draw lowered: {}",draws-fightDraws,why,lastDrop);}
        }
        fightDraws=draws;fightShots=shots;
    }

    /** Heights on a foe the bow may aim at, as fractions of its height: the middle first, then the chest, then the head. */
    static final double[] AIM_HEIGHTS={0.5,0.75,0.92};
    /** A full-power arrow's positions, tick by tick, from `from` along yaw/pitch (vanilla: move, then 0.99 drag and 0.05 gravity). */
    static List<Vec3> arrowPath(Vec3 from,float yaw,float pitch,int ticks) {
        double y=Math.toRadians(yaw),p=Math.toRadians(pitch);
        Vec3 velocity=new Vec3(-Math.sin(y)*Math.cos(p),-Math.sin(p),Math.cos(y)*Math.cos(p)).scale(3);
        List<Vec3> path=new ArrayList<>();path.add(from);Vec3 at=from;
        for(int t=0;t<ticks;t++){at=at.add(velocity);path.add(at);velocity=new Vec3(velocity.x*ARROW_DRAG,velocity.y*ARROW_DRAG-ARROW_GRAVITY,velocity.z*ARROW_DRAG);}
        return path;
    }
    /** Full-power arrow pitch (Minecraft sign: negative looks up) that crosses `horizontal` blocks at `dy` above the launch point, or NaN. */
    static double arrowPitch(double horizontal,double dy) {
        double lo=Math.toRadians(-45),hi=Math.toRadians(45);
        if(Double.isNaN(arrowHeight(hi,horizontal))||arrowHeight(hi,horizontal)<dy)return Double.NaN;
        for(int i=0;i<40;i++){double mid=(lo+hi)/2,h=arrowHeight(mid,horizontal);if(Double.isNaN(h)||h<dy)lo=mid;else hi=mid;}
        return -Math.toDegrees(hi);
    }
    /** Vanilla arrow flight: move by the velocity, then 0.99 drag and 0.05 gravity per tick, launched at 3 blocks per tick. */
    static double arrowHeight(double angle,double horizontal) {
        double vx=3*Math.cos(angle),vy=3*Math.sin(angle),x=0,y=0;
        for(int t=0;t<100&&vx>0.01;t++){
            if(x+vx>=horizontal)return y+vy*(horizontal-x)/vx;
            x+=vx;y+=vy;vx*=ARROW_DRAG;vy=vy*ARROW_DRAG-ARROW_GRAVITY;
        }
        return Double.NaN;
    }
    /** Distance from a point to the segment from `a` to `b`. */
    static double segmentDistance(Vec3 point,Vec3 a,Vec3 b) {
        Vec3 ab=b.subtract(a);double length=ab.lengthSqr();
        double t=length<1e-9?0:Math.max(0,Math.min(1,point.subtract(a).dot(ab)/length));
        return point.distanceTo(a.add(ab.scale(t)));
    }
    /**
     * Ticks until something at `from`, moving `velocity` per tick, enters `box` widened by HIT_MARGIN: 1 when its next move
     * does, -1 when it is already inside (stuck or passing: nothing to block) or does not within `horizon` ticks. After each
     * move the velocity is scaled by `drag` and loses `gravity` (1 and 0 for a straight flight, ARROW_DRAG and ARROW_GRAVITY for an arrow).
     */
    static int ticksToHit(Vec3 from,Vec3 velocity,double drag,double gravity,AABB box,int horizon) {
        AABB hit=box.inflate(HIT_MARGIN);
        Vec3 at=from;
        if(hit.contains(at))return -1;
        for(int t=1;t<=horizon;t++) {
            Vec3 next=at.add(velocity);
            if(hit.clip(at,next).isPresent())return t;
            at=next;velocity=new Vec3(velocity.x*drag,velocity.y*drag-gravity,velocity.z*drag);
        }
        return -1;
    }
    /** Winding up a shot at someone: a bow, trident or crossbow in use (by item class or by the use animation, so a modded weapon built on them counts), or a crossbow held loaded. */
    static boolean windingUp(LivingEntity entity) {
        ItemStack used=entity.getUseItem();
        if(entity.isUsingItem()&&(used.getItem() instanceof ProjectileWeaponItem||used.getUseAnimation()==UseAnim.BOW||used.getUseAnimation()==UseAnim.SPEAR||used.getUseAnimation()==UseAnim.CROSSBOW))return true;
        for(InteractionHand hand:InteractionHand.values()) {
            ItemStack held=entity.getItemInHand(hand);
            if(held.getItem() instanceof CrossbowItem&&CrossbowItem.isCharged(held))return true;
        }
        return false;
    }
    /**
     * Whether a shield can stop this projectile: not one the body or a player loosed (or anything friendly: a pet, a golem,
     * but a named monster still counts as an enemy), not one the body's own tag marks, not a potion (its splash ignores the
     * shield) and not a piercing arrow (vanilla's isDamageSourceBlocked lets those through).
     */
    static boolean blockable(Projectile shot) {
        Entity owner=shot.getOwner();
        if(owner instanceof Player||owner!=null&&!(owner instanceof Enemy)&&protectedEntity(owner))return false;
        if(shot.getTags().contains(BODY_PROJECTILE_TAG)||shot instanceof ThrownPotion)return false;
        return !(shot instanceof AbstractArrow arrow&&arrow.getPierceLevel()>0);
    }

    /** Tag put on every projectile the body looses; it outlives the body, so an arrow in flight after a logout stays harmless to players and pets. */
    static final String BODY_PROJECTILE_TAG="mcbot_body_projectile";
    /** Cancel damage that comes from the body (its own hit, or a tagged projectile) onto a protected victim other than the body itself. */
    static boolean blocksFriendlyFire(boolean sourceIsBody,boolean directIsBodyProjectile,boolean victimIsBody,boolean victimProtected) {
        return (sourceIsBody||directIsBodyProjectile)&&!victimIsBody&&victimProtected;
    }
    /** Players, anything tamed or named, leashed animals, villagers, golems that are not monsters, allays and armor stands. */
    static boolean protectedEntity(Entity entity) {
        if(entity instanceof Player||entity instanceof ArmorStand||entity instanceof Npc||entity instanceof Allay)return true;
        if(entity instanceof AbstractGolem&&!(entity instanceof Enemy))return true;
        if(entity instanceof OwnableEntity owned&&owned.getOwnerUUID()!=null)return true;
        if(entity instanceof Leashable leashed&&leashed.isLeashed())return true;
        return entity.hasCustomName();
    }
    /** A golem the village spawned: not built by a player, not named, not leashed. The only golem a hunt may be asked to kill. */
    static boolean wildGolem(boolean playerCreated,boolean named,boolean leashed){return !playerCreated&&!named&&!leashed;}
    static boolean wildGolem(Entity entity){return entity instanceof net.minecraft.world.entity.animal.IronGolem golem&&wildGolem(golem.isPlayerCreated(),golem.hasCustomName(),golem.isLeashed());}
    /** protectedEntity minus the village's own golem: what the hunt task refuses to pick as a target. */
    static boolean huntProtected(Entity entity){return protectedEntity(entity)&&!wildGolem(entity);}
    /** The golem a hunt is swinging at this very moment (set around that one swing, null otherwise). */
    private static volatile UUID huntSwing;
    static void huntSwing(UUID golem){huntSwing=golem;}
    /** Whether the one swing in flight may hurt this protected victim: only the hunted wild golem. */
    static boolean huntLicensed(boolean wildGolem,UUID victim,UUID swinging){return wildGolem&&victim.equals(swinging);}
    /** protectedEntity for damage from the body (the friendly-fire cancel): the same, except the wild golem a hunt is swinging at. */
    static boolean protectedFromBody(Entity entity){return protectedEntity(entity)&&!huntLicensed(wildGolem(entity),entity.getUUID(),huntSwing);}
    /** Loaded on first item check only: the component registry needs a bootstrapped game. */
    private static final class Known {
        static final Set<DataComponentType<?>> WEAPON=Set.of(DataComponents.DAMAGE,DataComponents.CUSTOM_NAME,DataComponents.LORE,DataComponents.REPAIR_COST,DataComponents.ENCHANTMENTS);
        static final Set<DataComponentType<?>> SHIELD=Set.of(DataComponents.DAMAGE,DataComponents.CUSTOM_NAME,DataComponents.LORE,DataComponents.REPAIR_COST,DataComponents.ENCHANTMENTS,DataComponents.BANNER_PATTERNS,DataComponents.BASE_COLOR);
    }
    /** A creeper's private explosion radius and fuse length, read once; the vanilla values (3 and 30) when a version hides them. */
    private static final class CreeperFacts {
        static final java.lang.reflect.Field RADIUS=field("explosionRadius"),MAX_SWELL=field("maxSwell");
        static java.lang.reflect.Field field(String name){try{java.lang.reflect.Field f=Creeper.class.getDeclaredField(name);f.setAccessible(true);return f;}catch(ReflectiveOperationException|RuntimeException missing){return null;}}
        static int read(java.lang.reflect.Field field,Creeper creeper,int vanilla){try{return field==null?vanilla:Math.max(1,field.getInt(creeper));}catch(ReflectiveOperationException|RuntimeException hidden){return vanilla;}}
    }
    private static final List<String> TIERS=List.of("netherite","diamond","iron","stone","golden","wooden");
    /** Vanilla item and class, only known data components, only vanilla enchantments, some durability left. */
    private static boolean verified(ItemStack stack,Class<?> kind,Set<DataComponentType<?>> allowed) {
        if(stack.isEmpty()||!kind.isInstance(stack.getItem())||!BuiltInRegistries.ITEM.getKey(stack.getItem()).getNamespace().equals("minecraft")||!stack.getItem().getClass().getName().startsWith("net.minecraft."))return false;
        for(var entry:stack.getComponentsPatch().entrySet())if(!allowed.contains(entry.getKey()))return false;
        for(var enchantment:stack.getEnchantments().keySet())if(!enchantment.unwrapKey().map(key->key.location().getNamespace().equals("minecraft")).orElse(false))return false;
        return !stack.isDamageableItem()||stack.getMaxDamage()-stack.getDamageValue()>4;
    }
    /** How to get a hand ready for melee: hold that slot, keep what is held, or stow the held stack into that main inventory slot; none when every slot is full. */
    enum Arm {HOLD,READY,STOW,NONE}
    record Arming(Arm arm,int slot) {}
    /**
     * Prefers the best verified weapon (bestWeapon, -1 when none; better: it beats the held one), then an empty hotbar
     * slot, then moving the held stack into an empty main inventory slot (9..35) so the bare hand fights. An unverified
     * or modded stack is never swung, only moved aside.
     */
    static Arming arming(int selected,boolean heldWeapon,boolean heldEmpty,int bestWeapon,boolean better,java.util.function.IntPredicate empty) {
        if(bestWeapon>=0&&(!heldWeapon||better))return new Arming(Arm.HOLD,bestWeapon);
        if(heldWeapon||heldEmpty)return new Arming(Arm.READY,selected);
        for(int i=0;i<9;i++)if(empty.test(i))return new Arming(Arm.HOLD,i);
        for(int i=9;i<36;i++)if(empty.test(i))return new Arming(Arm.STOW,i);
        return new Arming(Arm.NONE,-1);
    }
    static boolean meleeWeapon(ItemStack stack){return verified(stack,SwordItem.class,Known.WEAPON)||verified(stack,AxeItem.class,Known.WEAPON);}
    /** Lower is better: swords before axes (faster swings), better material first. */
    static int weaponRank(ItemStack stack) {
        String path=BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
        int tier=TIERS.indexOf(path.substring(0,Math.max(0,path.indexOf('_'))));
        return (stack.getItem() instanceof SwordItem?0:10)+(tier<0?9:tier);
    }
    static boolean bow(ItemStack stack) {
        // Flame arrows can light TNT and campfires; that is not part of guarding.
        return verified(stack,BowItem.class,Known.WEAPON)&&stack.getEnchantments().keySet().stream().noneMatch(e->e.is(net.minecraft.world.item.enchantment.Enchantments.FLAME));
    }
    static boolean shield(ItemStack stack){return verified(stack,ShieldItem.class,Known.SHIELD);}

    /** mayDrive: whether the guard may still move and swing (the guard duty's lease is live). */
    static GuardCombat create(BodyPlayer body,java.util.function.BooleanSupplier mayDrive,MinecraftServer server,String companionName,Options options) {
        GuardExecution execution=new GuardExecution(mayDrive);
        View view=new View() {
            NativeNavigation approach,retreat;Object approaching;
            int sequence;
            ServerPlayer companion(){return server.getPlayerList().getPlayerByName(companionName);}
            LivingEntity living(Foe foe){return (LivingEntity)foe.identity();}
            public long now(){return System.nanoTime()/1_000_000;}
            public Vec3 position(){return body.position();}
            public float health(){return body.getHealth();}
            public List<Foe> foes(Vec3 centre,double radius) {
                ServerPlayer player=companion();
                if(player==null)return List.of();
                AABB area=new AABB(centre,centre).inflate(radius+4).minmax(body.getBoundingBox().inflate(8));
                List<Foe> result=new ArrayList<>();
                for(LivingEntity entity:body.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e!=body&&e.isAlive()&&!e.isRemoved())) {
                    if(protectedEntity(entity)||entity.distanceTo(body)>BOW_MAX)continue;
                    Mob mob=entity instanceof Mob m?m:null;
                    boolean targetingCompanion=mob!=null&&mob.getTarget()==player||recent(player,entity);
                    boolean targetingSelf=mob!=null&&mob.getTarget()==body||recent(body,entity);
                    double companionDistance=entity.distanceTo(player),distance=entity.distanceTo(body);
                    boolean near=companionDistance<=radius||targetingCompanion&&companionDistance<=radius+4||targetingSelf&&distance<=8;
                    if(!near||!(ThreatSense.vanillaHostile(entity)||targetingCompanion||targetingSelf))continue;
                    String type=BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
                    boolean ranged=entity instanceof RangedAttackMob||entity instanceof Blaze||entity instanceof Ghast||entity instanceof Shulker;
                    boolean flying=entity instanceof FlyingMob||entity instanceof Blaze||entity instanceof Vex;
                    // Winding up a shot with the body as its own target: judged from what it holds and uses, not from what it is called.
                    // Aimed at the player instead, standing behind a shield protects nobody: the body goes for the foe as before.
                    boolean charging=mob!=null&&mob.getTarget()==body&&windingUp(entity);
                    int fuse=-1;double blast=0;
                    if(entity instanceof Creeper creeper) {
                        // Vanilla Creeper: explodes when `swell` reaches maxSwell (30); getSwelling(1) is swell/(maxSwell-2). The blast hurts out to twice its radius (3, doubled when charged).
                        int max=CreeperFacts.read(CreeperFacts.MAX_SWELL,creeper,30);
                        fuse=Math.max(0,max-(int)Math.round(creeper.getSwelling(1f)*(max-2)));
                        blast=2.0*CreeperFacts.read(CreeperFacts.RADIUS,creeper,3)*(creeper.isPowered()?2:1);
                    }
                    result.add(new Foe(entity,entity.getUUID().toString(),type,entity.position(),distance,companionDistance,targetingCompanion,targetingSelf,
                        ranged,entity instanceof Creeper,ThreatSense.explosionPreparing(entity),flying,body.hasLineOfSight(entity),fuse,blast,charging));
                }
                return result;
            }
            boolean recent(ServerPlayer victim,LivingEntity attacker){int age=victim.tickCount-victim.getLastHurtByMobTimestamp();return victim.getLastHurtByMob()==attacker&&age>=0&&age<=100;}
            public boolean dead(Foe foe){return !living(foe).isAlive();}
            public boolean inReach(Foe foe){LivingEntity e=living(foe);return body.canInteractWithEntity(e,0)&&body.hasLineOfSight(e);}
            public boolean approach(Foe foe,Vec3 centre,double leash) {
                if(approaching!=foe.identity()||approach==null){if(approach!=null)approach.stop();approach=new NativeNavigation(body,execution.capture()).tolerateDamage().sprint();approaching=foe.identity();}
                if(retreat!=null){retreat.stop();retreat=null;}
                LivingEntity e=living(foe);
                return approach.tick(e.position(),feet->feet.distanceTo(e.position())<=2.4,feet->feet.distanceTo(centre)<=leash);
            }
            public boolean retreat(Vec3 destination,Vec3 centre,double leash) {
                if(approach!=null){approach.stop();approach=null;approaching=null;}
                if(retreat==null)retreat=new NativeNavigation(body,execution.capture()).tolerateDamage().sprint();
                return retreat.tick(destination,feet->feet.distanceTo(destination)<=1.2,feet->feet.distanceTo(centre)<=leash+1);
            }
            public void stopMoving() {
                if(approach!=null){approach.stop();approach=null;approaching=null;}
                if(retreat!=null){retreat.stop();retreat=null;}
                body.stopInput();
            }
            /** Bring the stack in `slot` into the hotbar (swapping with an empty slot first, else the selected one) and select it. */
            boolean hold(int slot) {
                var permission=execution.capture();requireDrive(permission);
                if(body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty())return false;
                int hotbar=slot;
                if(slot>8) {
                    hotbar=body.getInventory().selected;
                    for(int i=0;i<9;i++)if(body.getInventory().getItem(i).isEmpty()){hotbar=i;break;}
                    int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                    if(menu<0)return false;
                    if(body.isUsingItem())body.stopUsingItem();
                    NativeWorkstation.click(body,body.inventoryMenu,menu,hotbar,ClickType.SWAP);
                    requireDrive(permission);
                }
                if(body.getInventory().selected!=hotbar){if(body.isUsingItem())body.stopUsingItem();body.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(hotbar));}
                return body.getInventory().selected==hotbar;
            }
            int best(java.util.function.Predicate<ItemStack> kind,Comparator<ItemStack> order) {
                int found=-1;
                for(int i=0;i<36;i++){ItemStack stack=body.getInventory().getItem(i);if(kind.test(stack)&&(found<0||order.compare(stack,body.getInventory().getItem(found))<0||order.compare(stack,body.getInventory().getItem(found))==0&&i==body.getInventory().selected))found=i;}
                return found;
            }
            public boolean armMelee() {
                ItemStack held=body.getMainHandItem();
                int slot=best(GuardCombat::meleeWeapon,Comparator.comparingInt(GuardCombat::weaponRank));
                boolean heldWeapon=meleeWeapon(held);
                Arming plan=arming(body.getInventory().selected,heldWeapon,held.isEmpty(),slot,slot>=0&&heldWeapon&&weaponRank(body.getInventory().getItem(slot))<weaponRank(held),i->body.getInventory().getItem(i).isEmpty());
                return switch(plan.arm()) {
                    case HOLD -> hold(plan.slot());
                    case READY -> true;
                    case STOW -> stow(plan.slot());
                    case NONE -> false;
                };
            }
            /** Move the held stack into the empty main inventory slot `slot` (the same native SWAP as hold()), leaving the hand bare. */
            boolean stow(int slot) {
                var permission=execution.capture();requireDrive(permission);
                if(body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty()||!body.getInventory().getItem(slot).isEmpty())return false;
                int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                if(menu<0)return false;
                if(body.isUsingItem())body.stopUsingItem();
                NativeWorkstation.click(body,body.inventoryMenu,menu,body.getInventory().selected,ClickType.SWAP);
                requireDrive(permission);
                return body.getMainHandItem().isEmpty();
            }
            public boolean cooledDown(){return body.getAttackStrengthScale(0.5f)>=1f;}
            public float attack(Foe foe) {
                LivingEntity e=living(foe);String id=foe.id();float[] dealt={0};RuntimeException[] refused={null};
                var permission=execution.capture();requireDrive(permission);
                NativeAttackScope scope=new NativeAttackScope() {
                    public boolean allowNativeTarget(String targetId){return id.equals(targetId)&&permission.getAsBoolean()&&!protectedEntity(e);}
                    public void refuseNative(RuntimeException failure){if(refused[0]==null)refused[0]=failure;}
                    public void receipt(String targetId,float amount){if(id.equals(targetId)&&Float.isFinite(amount)&&amount>0)dealt[0]+=amount;}
                };
                look(e.getEyePosition());
                SurvivalActions.scopedAttack(body,scope,()->body.attack(e));
                if(permission.getAsBoolean())body.swing(InteractionHand.MAIN_HAND,true);
                return refused[0]==null?dealt[0]:0;
            }
            public boolean hasBow(){return best(GuardCombat::bow,(a,b)->0)>=0&&!body.getProjectile(body.getInventory().getItem(best(GuardCombat::bow,(a,b)->0))).isEmpty();}
            public boolean armBow() {
                if(bow(body.getMainHandItem()))return !body.getProjectile(body.getMainHandItem()).isEmpty();
                int slot=best(GuardCombat::bow,(a,b)->0);
                return slot>=0&&hold(slot)&&!body.getProjectile(body.getMainHandItem()).isEmpty();
            }
            /** Height on the foe the bow aims at (see AIM_HEIGHTS), chosen by the last clearShot. */
            double aimHeight=0.5;
            public boolean clearShot(Foe foe) {
                LivingEntity e=living(foe);
                for(double height:AIM_HEIGHTS)if(arrowReaches(launch(),e,height)){aimHeight=height;return true;}
                return false;
            }
            /** Where vanilla looses the arrow from, for a body standing with its feet at `feet`. */
            Vec3 launch(Vec3 feet){return feet.add(0,body.getEyeHeight()-0.1,0);}
            Vec3 launch(){return launch(body.position());}
            /** A point at `height` of the foe, led by its horizontal motion over the flight. */
            Vec3 aimPoint(Vec3 from,LivingEntity e,double height) {
                AABB box=e.getBoundingBox();
                Vec3 point=new Vec3((box.minX+box.maxX)/2,box.minY+box.getYsize()*height,(box.minZ+box.maxZ)/2);
                double ticks=Math.sqrt(Math.pow(point.x-from.x,2)+Math.pow(point.z-from.z,2))/2.8;
                return point.add(e.getDeltaMovement().x*ticks,0,e.getDeltaMovement().z*ticks);
            }
            /** Yaw and pitch that bring a full-power arrow to `point`, or null when it is out of range. */
            float[] solution(Vec3 from,Vec3 point) {
                double dx=point.x-from.x,dz=point.z-from.z;
                double pitch=arrowPitch(Math.sqrt(dx*dx+dz*dz),point.y-from.y);
                return Double.isNaN(pitch)?null:new float[]{(float)Math.toDegrees(Math.atan2(-dx,dz)),(float)pitch};
            }
            /** Fly the arrow aimed at `height`: it must meet the foe before a block, and pass no protected entity, nor a little beyond in case it misses. */
            boolean arrowReaches(Vec3 from,LivingEntity e,double height) {
                float[] aim=solution(from,aimPoint(from,e,height));
                if(aim==null)return false;
                List<Vec3> path=arrowPath(from,aim[0],aim[1],100);
                AABB foe=e.getBoundingBox().inflate(HIT_MARGIN);
                int reached=-1;
                for(int i=1;i<path.size();i++) {
                    Vec3 a=path.get(i-1),b=path.get(i);
                    if(reached<0) {
                        Optional<Vec3> meets=foe.clip(a,b);
                        HitResult block=body.serverLevel().clip(new ClipContext(a,b,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,body));
                        boolean blocked=block.getType()!=HitResult.Type.MISS;
                        if(meets.isPresent()&&(!blocked||a.distanceToSqr(meets.get())<=a.distanceToSqr(block.getLocation())))reached=i;
                        else if(blocked)return false;
                    }
                    for(Entity other:body.serverLevel().getEntities(body,new AABB(a,b).inflate(2),o->o!=e&&protectedEntity(o))) {
                        AABB near=other.getBoundingBox().inflate(1.0);
                        if(near.contains(a)||near.clip(a,b).isPresent())return false;
                    }
                    if(reached>=0&&i>=reached+2)return true;
                }
                return reached>=0;
            }
            net.minecraft.world.entity.monster.Zombie walker;
            /** Where a walker could stand in the block column of `point`: at most a block above or below the body's feet, a floor vanilla's path types call walkable (no water, fire, cactus, or a drop). */
            Vec3 standAt(Vec3 point) {
                if(walker==null||walker.level()!=body.level())walker=new net.minecraft.world.entity.monster.Zombie(EntityType.ZOMBIE,body.level());
                int x=Mth.floor(point.x),z=Mth.floor(point.z),top=Mth.floor(body.getY())+1;
                for(int y=top;y>=top-2;y--) {
                    BlockPos pos=new BlockPos(x,y,z);
                    if(!body.serverLevel().isLoaded(pos))return null;
                    PathType type=WalkNodeEvaluator.getPathTypeStatic(walker,pos);
                    if(type==PathType.WALKABLE)return WalkNodeEvaluator.getPathTypeStatic(walker,pos.above())==PathType.OPEN?new Vec3(x+0.5,y,z+0.5):null; // and room for the head
                    if(type!=PathType.OPEN)return null; // the first non-air from above decides
                }
                return null;
            }
            public Vec3 shootingSpot(Foe foe,List<Vec3> candidates) {
                LivingEntity e=living(foe);Set<BlockPos> seen=new HashSet<>();int checked=0;
                seen.add(body.blockPosition());
                for(Vec3 candidate:candidates) {
                    Vec3 stand=standAt(candidate);
                    if(stand==null||!seen.add(BlockPos.containing(stand)))continue;
                    if(++checked>SPOT_MAX_CHECKED)break;
                    for(double height:AIM_HEIGHTS)if(arrowReaches(launch(stand),e,height))return stand;
                }
                return null;
            }
            public boolean reposition(Vec3 destination,Vec3 centre,double limit) {
                if(approach!=null){approach.stop();approach=null;approaching=null;}
                if(retreat==null)retreat=new NativeNavigation(body,execution.capture()).tolerateDamage().sprint();
                return retreat.tick(destination,feet->feet.distanceTo(destination)<=SPOT_ARRIVE,feet->feet.distanceTo(centre)<=limit);
            }
            public int drawing(){return body.isUsingItem()&&body.getUseItem().getItem() instanceof BowItem?body.getTicksUsingItem():-1;}
            void aim(LivingEntity e) {
                float[] solved=solution(launch(),aimPoint(launch(),e,aimHeight));
                if(solved==null){look(e.getEyePosition());body.setXRot(-45);return;}
                body.setYRot(solved[0]);body.setYHeadRot(solved[0]);body.setXRot(solved[1]);
            }
            public void draw(Foe foe) {
                aim(living(foe));
                if(drawing()<0){if(body.isUsingItem())body.stopUsingItem();body.connection.handleUseItem(new ServerboundUseItemPacket(InteractionHand.MAIN_HAND,++sequence,body.getYRot(),body.getXRot()));}
            }
            public void release(Foe foe) {
                aim(living(foe));
                body.connection.handlePlayerAction(new ServerboundPlayerActionPacket(ServerboundPlayerActionPacket.Action.RELEASE_USE_ITEM,BlockPos.ZERO,Direction.DOWN,++sequence));
                if(body.isUsingItem())body.stopUsingItem();
            }
            public void cancelDraw(){if(drawing()>=0)body.stopUsingItem();}
            public boolean armShield() {
                if(shield(body.getOffhandItem()))return true;
                if(!body.getOffhandItem().isEmpty()||body.containerMenu!=body.inventoryMenu||!body.inventoryMenu.getCarried().isEmpty())return false;
                int slot=best(GuardCombat::shield,(a,b)->0);
                if(slot<0)return false;
                int menu=NativeWorkstation.menuSlot(body.inventoryMenu,body.getInventory(),slot);
                if(menu<0)return false;
                NativeWorkstation.click(body,body.inventoryMenu,menu,Inventory.SLOT_OFFHAND,ClickType.SWAP);
                return shield(body.getOffhandItem());
            }
            public void raiseShield(Foe foe){raiseShieldAt(living(foe).getEyePosition());}
            public void raiseShieldAt(Vec3 point) {
                look(point);
                if(!(body.isUsingItem()&&body.getUsedItemHand()==InteractionHand.OFF_HAND)){
                    if(body.isUsingItem())body.stopUsingItem();
                    body.connection.handleUseItem(new ServerboundUseItemPacket(InteractionHand.OFF_HAND,++sequence,body.getYRot(),body.getXRot()));
                }
            }
            public void lowerShield(){if(body.isUsingItem()&&body.getUsedItemHand()==InteractionHand.OFF_HAND)body.stopUsingItem();}
            public List<Incoming> incoming(int ticks) {
                AABB box=body.getBoundingBox();
                List<Incoming> result=new ArrayList<>();
                // Within bow range of the body (BOW_MAX, as for foes); anything farther is found again as it comes closer.
                for(Projectile shot:body.serverLevel().getEntitiesOfClass(Projectile.class,box.inflate(BOW_MAX),p->p.isAlive()&&!p.isRemoved()&&blockable(p))) {
                    // Only an arrow's drop is modelled (its drag and gravity are the ones the bow's own aim uses); anything else flies straight over this short a stretch.
                    boolean arrow=shot instanceof AbstractArrow&&!shot.isNoGravity();
                    int hit=ticksToHit(shot.position(),shot.getDeltaMovement(),arrow?ARROW_DRAG:1,arrow?ARROW_GRAVITY:0,box,ticks);
                    if(hit>=0)result.add(new Incoming(shot,shot.position(),hit));
                }
                result.sort(Comparator.comparingInt(Incoming::ticks));
                return result;
            }
            void look(Vec3 point) {
                Vec3 delta=point.subtract(body.getEyePosition());float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
                body.setYRot(yaw);body.setYHeadRot(yaw);body.setXRot((float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance())));
            }
        };
        return new GuardCombat(view,options,execution);
    }
}
