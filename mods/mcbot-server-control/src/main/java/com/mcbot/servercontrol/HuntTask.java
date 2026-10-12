package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.FlyingMob;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.animal.IronGolem;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.monster.breeze.Breeze;
import net.minecraft.world.entity.monster.warden.Warden;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ProjectileWeaponItem;
import net.minecraft.world.item.TridentItem;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * hunt: kill up to `count` grown mobs of one type around a centre, as a player would: walk up, best sword or axe in
 * hand, one full-strength swing at a time, only the target can be hit (the same native attack scope as defense, no
 * sweep). Never players, villagers and traders, golems, owned or leashed animals, anything with a name, babies, or
 * creepers. Drops are picked up only by walking over them, as vanilla does. Stops when health falls to `lowHealth`.
 * One exception to the golem rule: an iron golem the village spawned (not built by a player, no name, not leashed) when
 * the hunt is asked for iron golems by type. It, and any ground melee mob when `pillar` is set, is fought from a pillar
 * of spare blocks beside it as high as the target (HuntPillar), and the pillar is dug back before the hunt ends.
 */
final class HuntTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,true,"Hunt task fault",false);}
    static final int MAX_RADIUS=16,WALK_MS=15_000;
    /** How near the feet walk up to the target (centre to centre) before swinging, or before pillaring up beside it. */
    static final double NEAR=2.4;
    private enum Phase { GROUND,RISING,UP,DOWN }
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final Vec3 center;
    private final int radius,count;
    private final float lowHealth;
    private final EntityType<?> type;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final Map<String,Integer> before;
    private final Set<UUID> hit=new HashSet<>(),skipped=new HashSet<>();
    private final List<String> killed=new ArrayList<>();
    private final Map<String,Integer> skippedWhy=new TreeMap<>();
    private float damage;
    private int swings;
    private LivingEntity target;
    private NativeNavigation navigation;
    private long walkStarted;
    private final boolean pillarMode;
    private final HuntPillar stand;
    private Phase phase=Phase.GROUND;
    private int levels;
    /** Coming down at the end of the hunt (then it finishes with finishCode, null for a plain finish), or only to go for the next target. */
    private boolean finishing;
    private String finishCode,note;

    HuntTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session,Vec3 center,SurvivalActions survival) {
        this.operation=operation;this.player=player;this.session=session;this.center=center;
        JsonObject args=operation.args;
        ResourceLocation key=ResourceLocation.tryParse(string(args,"type"));
        if(key==null||!BuiltInRegistries.ENTITY_TYPE.containsKey(key))throw error("INVALID_ARGUMENT","Unknown entity type "+string(args,"type"));
        type=BuiltInRegistries.ENTITY_TYPE.get(key);
        if(type==EntityType.PLAYER)throw error("FORBIDDEN","Players are never hunted");
        if(type==EntityType.CREEPER)throw error("UNSUPPORTED","Creepers explode when walked up to; the guard deals with them");
        pillarMode=type==EntityType.IRON_GOLEM||args.has("pillar")&&bool(args,"pillar");
        stand=new HuntPillar(player,session,survival,operation.id);
        radius=(int)bounded(args,"radius",12,1,MAX_RADIUS);
        count=(int)bounded(args,"count",1,1,16);
        lowHealth=(float)bounded(args,"lowHealth",8,2,18);
        long timeout=(long)bounded(args,"timeoutMs",60_000,5_000,180_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);
        before=ItemDescriptions.counts(player.getInventory());
        if(center.distanceTo(player.position())>32)throw error("OUT_OF_REACH","The area must be within 32 blocks");
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    /** What may be hunted at all: the wanted type, grown, and none of the protected kinds (a village's own iron golem is not one). */
    static boolean huntable(LivingEntity e,EntityType<?> type){return e.getType()==type&&e.isAlive()&&!e.isRemoved()&&!e.isBaby()&&!GuardCombat.huntProtected(e);}
    /**
     * Ground melee only, which the pillar stand beats: its reach is its own box widened sideways, so a body standing above
     * the box top is out of it. Not ranged or spell attackers, climbers, flyers, teleporters, or anything holding a bow, crossbow or trident.
     */
    static boolean pillarable(LivingEntity e) {
        if(!(e instanceof IronGolem||e instanceof Enemy))return false;
        if(e instanceof RangedAttackMob||e instanceof CrossbowAttackMob||e instanceof SpellcasterIllager||e instanceof FlyingMob||e instanceof Creeper)return false;
        if(e instanceof Blaze||e instanceof Shulker||e instanceof Vex||e instanceof Breeze||e instanceof Warden||e instanceof Guardian||e instanceof Spider||e instanceof EnderMan||e instanceof EnderDragon)return false;
        return !e.isHolding((Predicate<ItemStack>)s->s.getItem() instanceof ProjectileWeaponItem||s.getItem() instanceof TridentItem);
    }
    private List<LivingEntity> candidates(){return candidates(pillarMode);}
    private List<LivingEntity> candidates(boolean standable) {
        AABB area=new AABB(center.subtract(radius,6,radius),center.add(radius,6,radius));
        List<LivingEntity> found=new ArrayList<>(player.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e!=player&&huntable(e,type)&&(!standable||pillarable(e))&&e.position().distanceTo(center)<=radius&&!skipped.contains(e.getUUID())));
        found.sort(Comparator.comparingDouble(e->e.distanceToSqr(player)));
        return found;
    }
    JsonObject survey() {
        AABB area=new AABB(center.subtract(radius,6,radius),center.add(radius,6,radius));
        int total=0,babies=0,protectedOnes=0,huntable=0;
        for(LivingEntity e:player.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e.getType()==type&&e.isAlive()&&e.position().distanceTo(center)<=radius)) {
            total++;if(e.isBaby())babies++;else if(GuardCombat.huntProtected(e))protectedOnes++;else huntable++;
        }
        return obj("type",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"total",total,"huntable",huntable,"babies",babies,"protected",protectedOnes);
    }
    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        if(candidates().isEmpty()&&pillarMode&&!candidates(false).isEmpty()){JsonObject s=survey();s.addProperty("code","UNSUPPORTED");operation.finish("failed","UNSUPPORTED: the pillar stand only works on ground melee mobs; "+BuiltInRegistries.ENTITY_TYPE.getKey(type)+" shoots, climbs, flies or teleports",s);return;}
        if(candidates().isEmpty()){JsonObject s=survey();s.addProperty("code","NO_TARGET");operation.finish("failed","NO_TARGET: no grown, unprotected "+BuiltInRegistries.ENTITY_TYPE.getKey(type)+" within "+radius+" blocks",s);return;}
        if(pillarMode){String why=standRefusal(candidates().getFirst());if(why!=null){JsonObject s=survey();s.addProperty("code",why.substring(0,why.indexOf(':')));operation.finish("failed",why,s);return;}}
        armWeapon();
    }
    /** Before walking to a target: code and message when the stand cannot be built (too tall to stand over, or not enough blocks); null when it can. */
    private String standRefusal(LivingEntity e) {
        int need=HuntPillar.levels(player.getY(),e.getBoundingBox().maxY);
        String what=BuiltInRegistries.ENTITY_TYPE.getKey(type).toString();
        if(need>HuntPillar.MAX)return "UNSUPPORTED: "+what+" is taller than the "+HuntPillar.MAX+"-block stand";
        if(need>0&&stand.choose(need)==null)return "NO_BLOCKS: standing over "+what+" "+stand.lack(need);
        return null;
    }
    /** The best sword or axe into the hand (from the hotbar, or swapped in from the inventory); without one, what is held stays. */
    private void armWeapon() {
        Inventory inventory=player.getInventory();int best=-1;
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(GuardCombat.meleeWeapon(s)&&(best<0||GuardCombat.weaponRank(s)>GuardCombat.weaponRank(inventory.getItem(best))))best=i;}
        if(best<0||best==inventory.selected)return;
        select(player,best);
    }
    /** Make inventory slot `slot` (0..35) the held one: a main-inventory stack is swapped into an empty hotbar slot, else over the selected one. */
    static void select(BodyPlayer player,int slot) {
        Inventory inventory=player.getInventory();
        if(slot>8) {
            int hotbar=inventory.selected;for(int h=0;h<9;h++)if(inventory.getItem(h).isEmpty()){hotbar=h;break;}
            int menu=menuSlot(player.inventoryMenu,inventory,slot);if(menu<0)return;
            click(player,player.inventoryMenu,menu,hotbar,ClickType.SWAP);slot=hotbar;
        }
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot));
    }
    /** The hotbar slot holding a stack that fits, moving one in from the main inventory first when needed; -1 when the pack has none. */
    static int hotbarWith(BodyPlayer player,Predicate<ItemStack> wanted) {
        Inventory inventory=player.getInventory();
        for(int i=0;i<9;i++)if(wanted.test(inventory.getItem(i)))return i;
        for(int i=9;i<36;i++)if(wanted.test(inventory.getItem(i))){
            select(player,i);
            for(int h=0;h<9;h++)if(wanted.test(inventory.getItem(h)))return h;
            return -1;
        }
        return -1;
    }
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(phase==Phase.DOWN){comeDown();return;}
        if(phase==Phase.RISING){rise();return;}
        if(player.getHealth()<=lowHealth){end("LOW_HEALTH");return;}
        if(now()>=deadline){end("TIMEOUT");return;}
        if(target!=null&&!target.isAlive()) {
            if(hit.contains(target.getUUID()))killed.add(target.getUUID().toString());
            target=null;stopWalking();
        }
        if(killed.size()>=count){end(null);return;}
        if(target==null||!huntable(target,type)) {
            stopWalking();target=null;
            if(stand.height()>0){lower(false,null);return;}
            phase=Phase.GROUND;
            List<LivingEntity> left=candidates();
            if(left.isEmpty()){end(killed.isEmpty()?"NO_TARGET":null);return;}
            if(pillarMode) {
                String why=standRefusal(left.getFirst());
                if(why!=null){note=why.substring(why.indexOf(':')+2);end(why.substring(0,why.indexOf(':')));return;}
            }
            target=left.getFirst();walkStarted=now();
        }
        LivingEntity chased=target;
        if(pillarMode){standTick(chased);return;}
        if(player.canInteractWithEntity(chased,0)&&player.hasLineOfSight(chased)) {
            stopWalking();player.stopInput();
            if(player.getAttackStrengthScale(0.5f)<1f)return;
            strike(chased);return;
        }
        walkUp(chased);
    }
    private void walkUp(LivingEntity chased) {
        if(now()-walkStarted>WALK_MS){skip(chased,"walk timed out");return;}
        if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation).tolerateDamage();}
        try { navigation.tick(chased.position(),feet->feet.distanceTo(chased.position())<=NEAR); }
        catch(Protocol.Error failure) {
            if(failure.code.equals("NO_PATH")||failure.code.equals("OUT_OF_REACH")||failure.code.equals("PATH_BUDGET")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){skip(chased,failure.code+": "+failure.getMessage());return;}
            throw failure;
        }
    }

    // ---------- the pillar stand ----------
    /**
     * On the ground: walk up beside the target (a mob already coming for the body is waited for where the body stands), then
     * pillar up as high as its box; on the stand: swing whenever the target is in reach, until it dies or the limits end the hunt.
     */
    private void standTick(LivingEntity chased) {
        if(phase==Phase.UP) {
            if(player.canInteractWithEntity(chased,0)&&player.hasLineOfSight(chased)) {
                player.stopInput();
                if(player.getAttackStrengthScale(0.5f)<1f)return;
                strike(chased);return;
            }
            if(now()-walkStarted>WALK_MS)skip(chased,"out of reach from the stand");
            return;
        }
        boolean coming=chased instanceof Mob mob&&mob.getTarget()==player;
        if(!coming&&chased.position().distanceTo(player.position())>NEAR){walkUp(chased);return;}
        stopWalking();player.stopInput();
        if(!player.onGround())return;
        levels=HuntPillar.levels(player.getY(),chased.getBoundingBox().maxY);
        String why=standRefusal(chased);
        if(why!=null){
            if(why.startsWith("UNSUPPORTED")){skip(chased,why);return;}
            note=why.substring(why.indexOf(':')+2);end("NO_BLOCKS");return;
        }
        walkStarted=now();
        if(levels<=0){phase=Phase.UP;armWeapon();return;}
        stand.startRise(levels);
        phase=Phase.RISING;
    }
    /** Block by block up to `levels`, then back to the weapon. A refusal gives this target up and comes down what was built. */
    private void rise() {
        try { if(stand.rise(levels)){phase=Phase.UP;walkStarted=now();armWeapon();} }
        catch(Protocol.Error refused) {
            if(refused.code.equals("UNKNOWN"))throw refused;
            stand.forget();
            if(target!=null)skip(target,"PILLAR "+refused.code+": "+refused.getMessage());
            lower(false,null);
        }
    }
    /** Dig the stand back; afterwards finish the hunt when it ended, else go on with the next target. */
    private void lower(boolean finishing,String code) {
        stopWalking();player.stopInput();
        phase=Phase.DOWN;this.finishing=finishing;finishCode=code;
    }
    private void comeDown() {
        if(!stand.descend())return;
        phase=Phase.GROUND;armWeapon();
        if(stand.height()>0)note=(note==null?"":note+"; ")+stand.height()+" stand blocks left standing";
        if(finishing)finish(finishCode);
    }
    /** The hunt is over (code: why, null for done): from the stand, come down first. */
    private void end(String code) {
        if(stand.height()>0&&phase!=Phase.DOWN)lower(true,code);
        else finish(code);
    }

    private void strike(LivingEntity e) {
        String id=e.getUUID().toString();float[] dealt={0};RuntimeException[] refused={null};
        NativeAttackScope scope=new NativeAttackScope() {
            public boolean allowNativeTarget(String targetId){return id.equals(targetId)&&session.mayDrive(operation)&&!GuardCombat.huntProtected(e);}
            public void refuseNative(RuntimeException failure){if(refused[0]==null)refused[0]=failure;}
            public void receipt(String targetId,float amount){if(id.equals(targetId)&&Float.isFinite(amount)&&amount>0)dealt[0]+=amount;}
        };
        look(player,e.getEyePosition());
        // The friendly-fire cancel (ServerController) lets this one swing through when the target is a village's own golem.
        GuardCombat.huntSwing(e.getUUID());
        try { SurvivalActions.scopedAttack(player,scope,()->player.attack(e)); }
        finally { GuardCombat.huntSwing(null); }
        player.swing(InteractionHand.MAIN_HAND,true);swings++;
        if(refused[0]!=null)throw refused[0];
        if(dealt[0]>0){hit.add(e.getUUID());damage+=dealt[0];}
    }
    private void skip(LivingEntity e,String why){skipped.add(e.getUUID());skippedWhy.merge(why,1,Integer::sum);target=null;stopWalking();}
    private void stopWalking(){if(navigation!=null)navigation.stop();navigation=null;}
    /** Walking up to the next one; not in the middle of a swing, a pillar jump or on the stand. */
    @Override public boolean interruptible(){return phase==Phase.GROUND&&navigation!=null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){stopWalking();player.stopInput();walkStarted=now();deadline+=grace.grant(fightMs);}
    JsonObject progress() {
        JsonObject result=obj("type",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"requested",count,"killed",killed.size(),"swings",swings,"damage",damage);
        if(!skipped.isEmpty()){result.addProperty("unreachable",skipped.size());JsonObject why=new JsonObject();skippedWhy.forEach(why::addProperty);result.add("unreachableWhy",why);}
        if(pillarMode){result.addProperty("pillar",true);result.addProperty("standBlocksLeft",stand.height());}
        if(note!=null)result.addProperty("note",note);
        result.add("inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())));
        return result;
    }
    private void finish(String code) {
        stop();JsonObject result=progress();
        if(code!=null)result.addProperty("code",code);
        String what=killed.size()+" of "+count+" "+BuiltInRegistries.ENTITY_TYPE.getKey(type),why=note==null?"":" ("+note+")";
        if(killed.isEmpty()){operation.finish("failed",(code!=null?code:"UNREACHABLE")+": killed none"+why,result);return;}
        operation.finish("succeeded",(code!=null?code+": ":"")+"Killed "+what+why,result);
    }
    @Override public void stop(){stopWalking();player.stopInput();target=null;stand.forget();}
}
