package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.Mth;
import net.minecraft.util.RandomSource;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.monster.Zombie;
import net.minecraft.world.level.CollisionGetter;
import net.minecraft.world.level.PathNavigationRegion;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.pathfinder.*;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * One loaded-only navigation driver shared by movement, interaction approaches and pickup.
 * Routes come from vanilla's walking path finder (the one zombies and villagers use: steps, slopes,
 * one-block jumps, safe drops, no water/lava/fire), computed for a detached zombie standing where
 * the body stands. Driving follows vanilla PathNavigation/MoveControl: steer at the next node,
 * jump when it is a block higher, advance within the waypoint radius, replan when stuck.
 * On top of vanilla, a route may leap a one-block gap: straight across, landing on walkable ground at
 * the same level two blocks ahead, with headroom for the arc. The driver runs at the gap from inside the
 * take-off block and jumps once vanilla's walking-jump physics put the landing in the middle of that block.
 */
final class NativeNavigation {
    static final int MAX_REPLANS=4,MAX_RANGE=48,MAX_VISITED=2048,WIDE_VISITED=6000;
    static final double WAYPOINT=0.45,STUCK_MS=2000,FINAL_APPROACH=1.5;
    /**
     * Gap leap, in blocks from the take-off block centre toward the gap: jump from TAKEOFF_FROM on when the
     * predicted landing is LAND_MIN..LAND_MAX (the landing block centre is 2); never jump past EDGE (the body
     * falls once its centre is 0.8 out); back up to RUN_UP for another run.
     */
    static final double TAKEOFF_FROM=0.05,EDGE=0.6,LAND_MIN=1.6,LAND_MAX=2.4,RUN_UP=-0.3;
    /**
     * Caught on the edge of a step up (jumping in place, a side of the body against the corner): after LEDGE_MS of that,
     * back to the middle of the take-off block and come at the step straight, as a player does, instead of jumping on
     * until the stuck timer replans (10-12 playtest: it jumped a while, then took another way). At most REALIGNS per step.
     */
    static final long LEDGE_MS=700,REALIGN_MS=1200;
    static final int REALIGNS=2;
    private Vec3 ledgeNode,realignTo;
    private long ledgeSince,realignUntil;
    private int realigns,ledges;
    private String lastLedge;
    /** Swimming out: shores are looked for this far around, and one that brings no progress this long is dropped. */
    static final int SHORE_RANGE=10;
    static final long SWIM_STUCK_MS=4000;
    private Vec3 shore;
    private double shoreGap;
    private long shoreSince;
    private final Set<BlockPos> badShores=new HashSet<>();
    private int swimTries,swims;
    private final BodyPlayer body;
    private final java.util.function.BooleanSupplier mayDrive;
    private final Object dimension;
    private float initialHealth;
    private java.util.function.BooleanSupplier damageToleratedWhile=()->false;
    private Zombie model;
    private RouteEvaluator evaluator;
    private PathFinder finder;
    private List<Vec3> route;
    private int index,replans;
    private int plans,routePoints,totalReplans,visitedLimit;
    private long searchNanos,maxSearchNanos;
    private Vec3 target,progress,replanAnchor;
    private long lastProgress,lastPlan;
    private boolean stopped,jumped,backing,damageTolerated;
    private int leaps;
    private int lastTick=Integer.MIN_VALUE;
    private boolean arrivedThisTick;
    NativeNavigation(BodyPlayer body,ControlSession session,ControlSession.Operation operation){this(body,()->session.mayDrive(operation));}
    /** Driven by something other than one operation (the guard duty): mayDrive says whether it may still move the body. */
    NativeNavigation(BodyPlayer body,java.util.function.BooleanSupplier mayDrive){
        this.body=body;this.mayDrive=mayDrive;dimension=body.serverLevel();initialHealth=body.getHealth();
        progress=replanAnchor=body.position();lastProgress=clock();
    }
    private static long clock(){return System.nanoTime()/1_000_000;}
    /** Water is allowed: a body in water swims out to the shore first (swim()), then walks on. */
    static void conditions(BodyPlayer body) {
        if(body.containerMenu!=body.inventoryMenu)throw error("BUSY","Close the container before navigating");
        if(!body.isAlive()||body.isRemoved()||body.isInLava()||body.isPassenger()||body.isFallFlying()||body.isSleeping()||body.getPose()!=Pose.STANDING||body.isOnFire()||body.getTicksFrozen()>0)
            throw error("BLOCKED","Body cannot safely navigate in its current state");
    }
    boolean tick(Vec3 destination,Predicate<Vec3> goal){return tick(destination,goal,p->true);}
    boolean tick(Vec3 destination,Predicate<Vec3> goal,Predicate<Vec3> allowed){
        if(stopped||!mayDrive.getAsBoolean()){stop();return false;}
        conditions(body);if(body.serverLevel()!=dimension)throw error("STALE_TARGET","Navigation dimension changed");
        if(!damageTolerated&&!damageToleratedWhile.getAsBoolean()&&body.getHealth()<initialHealth){
            var source=body.getLastDamageSource();
            throw error("BLOCKED","Body took damage during navigation"+(source!=null?" ("+source.getMsgId()+")":"")+"; safe movement was not confirmed");
        }
        int tick=body.getServer().getTickCount();if(lastTick==tick)return arrivedThisTick;
        lastTick=tick;arrivedThisTick=false;
        Vec3 feet=body.position();long now=clock();
        if(!allowed.test(feet))throw error("OUT_OF_REACH","Navigation left its authorized region");
        if(body.onGround()&&goal.test(feet)){
            body.stopInput();route=null;replans=0;progress=replanAnchor=feet;lastProgress=now;arrivedThisTick=true;doors.arrived();return true;
        }
        if(feet.distanceToSqr(progress)>0.09){progress=feet;lastProgress=now;}
        // Real progress since the last replan earns the finite replan budget back.
        if(feet.distanceTo(replanAnchor)>2){replans=0;replanAnchor=feet;}
        if(body.isInWater()){swim(feet,destination,allowed,now);return false;}
        // Bobbing up out of the water for a moment is not landing: forget the tried shores only once on the ground.
        if(shore!=null&&body.onGround()){shore=null;badShores.clear();swimTries=0;}
        if(route!=null&&now-lastProgress>STUCK_MS){
            if(!body.onGround())throw error("BLOCKED","Airborne navigation made no progress");
            replan(now);lastProgress=now;
        }
        // A moving destination (a walking player) is re-routed at most twice a second, from the ground.
        if(route!=null&&target!=null&&destination.distanceTo(target)>1&&now-lastPlan>=500&&body.onGround())route=null;
        if(route==null){
            if(!body.onGround()){steer(feet,null);return false;}
            plan(feet,destination,goal,allowed,now);
            if(!mayDrive.getAsBoolean()){stop();return false;}
        }
        while(index<route.size()&&reached(feet,route.get(index)))index++;
        if(index>=route.size()){
            // Route used up but the goal is not met yet (a dropped item still falling, or lying just off the
            // last block centre): step straight at a close destination, and replan no more than twice a second
            // so a settling target does not burn the whole replan budget in a few ticks.
            Vec3 level=new Vec3(destination.x,feet.y,destination.z);
            if(body.onGround()&&level.subtract(feet).horizontalDistance()<=FINAL_APPROACH&&destination.y-feet.y<2.5&&destination.y-feet.y>-1&&allowed.test(level)&&floored(feet,level)){steer(feet,level);return false;}
            if(now-lastPlan<500){body.stopInput();return false;}
            replan(now);return false;
        }
        Vec3 next=route.get(index);
        if(!allowed.test(next))throw error("OUT_OF_REACH","Next navigation node left its authorized region");
        if(doors.tick(feet,route,index))return false;
        if(realignTo!=null){realign(feet,now);return false;}
        if(caught(feet,next,now))return false;
        if(index>0&&leap(route.get(index-1),next))leap(feet,route.get(index-1),next);
        else{backing=false;steer(feet,next);}
        return false;
    }
    /** Up against a step it keeps failing to jump onto: start backing to the middle of the take-off block. */
    private boolean caught(Vec3 feet,Vec3 next,long now) {
        if(!next.equals(ledgeNode)){ledgeNode=next;ledgeSince=0;realigns=0;}
        boolean against=body.horizontalCollision&&next.y-feet.y>body.maxUpStep()&&Math.hypot(next.x-feet.x,next.z-feet.z)<1.5;
        if(!against){if(body.onGround())ledgeSince=0;return false;} // in the air the push against it may lapse for a tick
        if(ledgeSince==0){ledgeSince=now;return false;}
        if(now-ledgeSince<LEDGE_MS||!body.onGround()||realigns>=REALIGNS)return false;
        realigns++;ledges++;ledgeSince=0;
        Vec3 from=index>0?route.get(index-1):null;
        realignTo=from!=null&&Math.abs(from.y-feet.y)<0.6&&Math.hypot(from.x-feet.x,from.z-feet.z)<1.2?from:new Vec3(Math.floor(feet.x)+0.5,feet.y,Math.floor(feet.z)+0.5);
        lastLedge=String.format("caught on the step up to %.0f %.0f %.0f at %.1f %.1f %.1f: back to the middle and straight at it",Math.floor(next.x),next.y,Math.floor(next.z),feet.x,feet.y,feet.z);
        realignUntil=now+REALIGN_MS;body.stopInput();return true;
    }
    /** Walk (no jumping) to the middle of the take-off block; from there the ordinary steering comes at the step straight. */
    private void realign(Vec3 feet,long now) {
        Vec3 d=realignTo.subtract(feet);double gap=d.horizontalDistance();
        if(body.onGround()&&gap<0.15||now>realignUntil){body.stopInput();realignTo=null;return;}
        body.jumpInput(false);body.sprintInput(false);
        body.moveInput(d.x,d.z,(float)Math.min(1,gap/0.4));
    }
    /** Times it was caught on a step edge and realigned, and the last one, for a caller's trace. */
    int ledges(){return ledges;}
    String lastLedge(){return lastLedge;}
    /** Two route points two blocks apart on one level are a gap leap (vanilla nodes are never more than one block apart). */
    static boolean leap(Vec3 from,Vec3 to){return Math.abs(to.y-from.y)<0.01&&to.subtract(from).horizontalDistance()>1.9;}
    record Leap(boolean back,boolean jump){}
    /**
     * One ground tick of a gap leap, from how far the feet are past the take-off block centre toward the gap
     * and the predicted jump length: jump when it lands mid-block; still short, keep running while there is
     * room; would overshoot, or no room left, walk back to the run-up spot and try again.
     */
    static Leap leapInput(double along,double jumpLength,boolean backing){
        if(backing&&along>RUN_UP+0.05)return new Leap(true,false);
        if(along<TAKEOFF_FROM)return new Leap(false,false);
        double landing=along+jumpLength;
        if(landing>=LAND_MIN&&landing<=LAND_MAX)return new Leap(false,true);
        return new Leap(landing>LAND_MAX||along>EDGE,false);
    }
    /**
     * How far a jump taken now carries horizontally before landing back on the same level, following vanilla
     * LivingEntity#travel with forward input held: the take-off tick still moves with ground acceleration and
     * friction (speed is the post-friction motion along the leap), then air acceleration and drag until the
     * jump arc (0.42 up, gravity 0.08, drag 0.98) comes back down.
     */
    static double jumpLength(double speed,double groundAccel){
        double v=speed,total=0,y=0,vy=0.42;
        for(int tick=0;tick<30;tick++){
            boolean ground=tick==0;
            double step=v+(ground?groundAccel:0.02*0.98);
            total+=step;v=step*(ground?0.546:0.91);
            y+=vy;vy=(vy-0.08)*0.98;
            if(y<=0)break;
        }
        return total;
    }
    private void leap(Vec3 feet,Vec3 from,Vec3 to){
        Vec3 dir=new Vec3(to.x-from.x,0,to.z-from.z).normalize();
        Vec3 toLanding=to.subtract(feet);
        body.sprintInput(false);
        if(!body.onGround()){body.jumpInput(false);body.moveInput(toLanding.x,toLanding.z,1);return;} // keep heading for the landing in the air
        Vec3 motion=body.getDeltaMovement();
        double along=(feet.x-from.x)*dir.x+(feet.z-from.z)*dir.z,speed=motion.x*dir.x+motion.z*dir.z;
        Leap step=leapInput(along,jumpLength(speed,body.getSpeed()*0.98),backing);
        backing=step.back();
        if(step.back()){
            Vec3 spot=from.add(dir.scale(RUN_UP)).subtract(feet);
            body.jumpInput(false);body.moveInput(spot.x,spot.z,(float)Math.min(1,spot.horizontalDistance()/0.4));return;
        }
        body.jumpInput(step.jump());body.moveInput(toLanding.x,toLanding.z,1);
        if(step.jump()){jumped=true;leaps++;}
    }
    /**
     * In water the walking planner has nothing to stand on, so swim like a player: hold jump to stay at the surface
     * and swim at a shore spot. Vanilla lifts a swimmer who pushes against a bank while jumping out onto it; on land
     * the ordinary route takes over. A shore that brings no progress for a while is dropped for the next best one.
     */
    private void swim(Vec3 feet,Vec3 destination,Predicate<Vec3> allowed,long now){
        route=null;
        if(shore!=null){
            // Bobbing at the surface moves the body without getting anywhere: only closing in on the shore counts.
            double gap=Math.hypot(shore.x-feet.x,shore.z-feet.z);
            if(gap<shoreGap-0.3){shoreGap=gap;shoreSince=now;}
            else if(now-shoreSince>SWIM_STUCK_MS){
                badShores.add(BlockPos.containing(shore));shore=null;
                if(++swimTries>MAX_REPLANS)throw error("BLOCKED","Could not swim out of the water");
            }
        }
        if(shore==null){
            shore=shore(feet,destination,allowed);lastProgress=now;progress=feet;
            if(shore==null)throw error("NO_PATH","No shore level with the water within "+SHORE_RANGE+" blocks; a bank a block higher cannot be climbed from the water");
            shoreGap=Math.hypot(shore.x-feet.x,shore.z-feet.z);shoreSince=now;swims++;
        }
        Vec3 delta=shore.subtract(feet);
        body.sprintInput(false);body.jumpInput(true);jumped=true;
        body.moveInput(delta.x,delta.z,(float)Math.min(1,delta.horizontalDistance()/0.4));
    }
    /**
     * The walkable spot (solid floor, room to stand, no water or danger) a swimmer can climb onto that is best on the
     * way: closest to the body, with the remaining distance to the destination counting half. Only a bank level with
     * the water surface: vanilla lifts a swimmer over a lip of a few tenths of a block, never over a bank a whole block
     * higher (measured in game: the body bobbed up to 0.14 short of such a bank and stayed there).
     */
    private Vec3 shore(Vec3 feet,Vec3 destination,Predicate<Vec3> allowed){
        ensureModel();
        Vec3 best=null;double score=Double.MAX_VALUE;
        int fx=Mth.floor(feet.x),fy=Mth.floor(feet.y),fz=Mth.floor(feet.z);
        // The swimmer rises to the surface first: banks are measured from there, not from where it sank to.
        int surface=fy;
        while(surface<fy+SHORE_RANGE&&!body.serverLevel().getFluidState(new BlockPos(fx,surface,fz)).isEmpty())surface++;
        for(int dx=-SHORE_RANGE;dx<=SHORE_RANGE;dx++)for(int dz=-SHORE_RANGE;dz<=SHORE_RANGE;dz++){
            if(dx*dx+dz*dz>SHORE_RANGE*SHORE_RANGE)continue;
            for(int y=surface;y>=fy-2;y--){
                BlockPos pos=new BlockPos(fx+dx,y,fz+dz);
                if(!body.serverLevel().isLoaded(pos))break;
                PathType type=WalkNodeEvaluator.getPathTypeStatic(model,pos);
                if(type==PathType.OPEN)continue;
                // The first non-air from above decides: a bank to stand on, or water, a wall or danger (nothing here).
                Vec3 spot=new Vec3(pos.getX()+0.5,pos.getY(),pos.getZ()+0.5);
                // The bank right at the water's edge is WATER_BORDER to vanilla, not WALKABLE: it is the spot a swimmer climbs onto.
                if((type==PathType.WALKABLE||type==PathType.WATER_BORDER)&&!badShores.contains(pos)&&allowed.test(spot)){
                    double s=spot.distanceTo(feet)+0.5*spot.distanceTo(destination);
                    if(s<score){score=s;best=spot;}
                }
                break;
            }
        }
        return best;
    }
    private void ensureModel(){
        if(model==null||model.level()!=body.level()){
            // A long walk steps down one block at a time: whatever it walks down it can walk back up, so it never
            // drops into a hole or onto a ledge it cannot leave (a body jumps up one block, vanilla drops three).
            int drop=wide?1:maxDrop;
            model=drop>0?new Zombie(EntityType.ZOMBIE,body.level()){@Override public int getMaxFallDistance(){return drop;}}:new Zombie(EntityType.ZOMBIE,body.level());
            // Routes never go through water (a body already in water swims out first, swim()) or powder snow. Wooden doors are opened by hand on the way (doors()).
            model.setPathfindingMalus(PathType.WATER,-1);model.setPathfindingMalus(PathType.WATER_BORDER,8);
            model.setPathfindingMalus(PathType.DANGER_FIRE,-1);model.setPathfindingMalus(PathType.DAMAGE_FIRE,-1);
            model.setPathfindingMalus(PathType.DANGER_POWDER_SNOW,-1);model.setPathfindingMalus(PathType.POWDER_SNOW,-1);
            model.setPathfindingMalus(PathType.DANGER_OTHER,-1);model.setPathfindingMalus(PathType.DAMAGE_OTHER,-1);
            evaluator=new RouteEvaluator();evaluator.leaps=!wide;evaluator.setCanPassDoors(true);evaluator.setCanOpenDoors(true);evaluator.setCanFloat(false);
        }
    }
    /**
     * A random loaded spot a few blocks around a centre where vanilla would let a walker stand
     * (solid floor, room for the body, no water, fire, powder snow or other danger), or null.
     */
    Vec3 strollPoint(Vec3 centre,double minRadius,double maxRadius,RandomSource random){
        ensureModel();
        for(int attempt=0;attempt<12;attempt++){
            double angle=random.nextDouble()*Math.PI*2,radius=minRadius+random.nextDouble()*(maxRadius-minRadius);
            int x=Mth.floor(centre.x+Math.cos(angle)*radius),z=Mth.floor(centre.z+Math.sin(angle)*radius),top=Mth.floor(centre.y)+2;
            for(int y=top;y>=top-5;y--){
                BlockPos pos=new BlockPos(x,y,z);
                if(!body.serverLevel().isLoaded(pos))break;
                PathType type=WalkNodeEvaluator.getPathTypeStatic(model,pos);
                if(type==PathType.WALKABLE)return new Vec3(x+0.5,y,z+0.5);
                if(type!=PathType.OPEN)break; // the first non-air from above decides: a wall, water or danger is no floor
            }
        }
        return null;
    }
    private void plan(Vec3 feet,Vec3 destination,Predicate<Vec3> goal,Predicate<Vec3> allowed,long now){
        body.stopInput();
        ensureModel();
        model.moveTo(feet.x,feet.y,feet.z,body.getYRot(),0);model.setOnGround(body.onGround());
        float range=wide?MAX_RANGE:(float)Math.min(MAX_RANGE,feet.distanceTo(destination)+(roomy?32:16));
        visitedLimit=wide?WIDE_VISITED:roomy?Math.min(WIDE_VISITED,(int)(range*96)):Math.min(MAX_VISITED,(int)(range*16));
        finder=new PathFinder(evaluator,visitedLimit);
        evaluator.allowed=allowed;
        BlockPos from=body.blockPosition();int radius=(int)range+8;
        long began=System.nanoTime();
        Path path=finder.findPath(new PathNavigationRegion(body.level(),from.offset(-radius,-radius,-radius),from.offset(radius,radius,radius)),
            model,Set.of(BlockPos.containing(destination)),range,0,1); // reach the target block itself: one block short is outside item pickup reach
        long elapsed=System.nanoTime()-began;searchNanos+=elapsed;maxSearchNanos=Math.max(maxSearchNanos,elapsed);plans++;
        if(path==null||path.getNodeCount()==0)throw error("NO_PATH","No loaded walkable route from the current position");
        List<Vec3> points=new ArrayList<>();
        for(int i=0;i<path.getNodeCount();i++){Node node=path.getNode(i);points.add(new Vec3(node.x+0.5,node.y,node.z+0.5));}
        // The last node is a block centre; a nearby, allowed goal point (an item, a stand spot) is the final steer.
        Vec3 last=points.getLast();
        if(path.canReach()&&goal.test(destination)&&allowed.test(destination)&&last.subtract(destination).horizontalDistance()<=FINAL_APPROACH&&Math.abs(last.y-destination.y)<0.6)points.add(destination);
        if(points.size()==1&&reached(feet,points.getFirst())&&!goal.test(feet)&&!path.canReach())throw error("NO_PATH","No loaded walkable route makes progress toward the destination");
        route=points;index=0;realignTo=null;ledgeNode=null;target=destination;lastPlan=now;lastProgress=now;progress=feet;routePoints=points.size();
    }
    /** The straight final step stays on solid floor: no hole under its middle or its end. */
    private boolean floored(Vec3 feet,Vec3 to){
        for(Vec3 p:List.of(feet.lerp(to,0.5),to)){
            BlockPos below=BlockPos.containing(p.x,feet.y-0.5,p.z);
            if(!body.serverLevel().isLoaded(below)||body.serverLevel().getBlockState(below).getCollisionShape(body.serverLevel(),below).isEmpty())return false;
        }
        return true;
    }
    /** Vanilla PathNavigation#followThePath: inside the waypoint radius horizontally and less than a block vertically. */
    static boolean reached(Vec3 feet,Vec3 node){
        return Math.abs(feet.x-node.x)<=WAYPOINT&&Math.abs(feet.z-node.z)<=WAYPOINT&&Math.abs(feet.y-node.y)<1;
    }
    private void steer(Vec3 feet,Vec3 next){
        if(next==null){if(body.onGround())body.stopInput();return;}
        Vec3 delta=next.subtract(feet);
        Input input=inputs(delta,body.onGround(),body.horizontalCollision,body.maxUpStep());
        body.jumpInput(input.jump());jumped|=input.jump();
        if(input.forward()>0)body.moveInput(delta.x,delta.z,input.forward());else{body.forwardInput=0;}
        body.sprintInput(sprint);
    }
    record Input(float forward,boolean jump){}
    /** Vanilla MoveControl: jump when the next node is higher than a step and close, or when a wall stops a rising leg. */
    static Input inputs(Vec3 delta,boolean onGround,boolean blocked,double maxUpStep){
        double distance=delta.horizontalDistance();
        boolean jump=onGround&&(delta.y>maxUpStep&&distance*distance<1.0||blocked&&delta.y>0.05);
        return new Input(distance<=0.08?0:(float)Math.min(1,distance/0.4),jump);
    }
    private void replan(long now){
        body.stopInput();totalReplans++;if(++replans>MAX_REPLANS)throw error("BLOCKED","Navigation finite obstacle/stuck replan budget exhausted");
        route=null;lastPlan=now;
    }
    void stop(){stopped=true;route=null;realignTo=null;body.stopInput();}
    /** A guarding body fights while it walks: damage is expected, not a sign of an unsafe route. */
    NativeNavigation tolerateDamage(){damageTolerated=true;return this;}
    /** Damage is expected while `when` holds (a guard duty protects the player this follows); afterwards only new damage counts. */
    NativeNavigation tolerateDamageWhile(java.util.function.BooleanSupplier when){damageToleratedWhile=when;return this;}
    /** Count damage from now on only (after a fight the guard duty took the body for). */
    void rebaseHealth(){initialHealth=body.getHealth();}
    /** A leg of a long walk: search the whole range with a larger node budget, to find the way round a cliff or along a river. */
    NativeNavigation wide(){wide=true;return this;}
    private boolean wide;
    /** A bigger search for a near goal, keeping the ordinary drops and leaps: in a house the way to a spot two blocks off may go down the stairs and out of the door. */
    NativeNavigation roomy(){roomy=true;return this;}
    private boolean roomy;
    /** Routes may jump down this far (a body stranded up on a roof, as a player jumps off); 0 keeps the vanilla three. */
    NativeNavigation drops(int blocks){maxDrop=blocks;return this;}
    private int maxDrop;
    /** Run instead of walk on ordinary legs (chasing or fleeing a mob); never on a gap leap, which is timed for walking speed. */
    NativeNavigation sprint(){sprint=true;return this;}
    private boolean sprint;
    /** Someone else drove the body meanwhile: forget the old route and start fresh from where it stands now. */
    void reset(){route=null;realignTo=null;replans=0;shore=null;swimTries=0;badShores.clear();progress=replanAnchor=body.position();lastProgress=clock();body.stopInput();}
    private final NavigationDoors doors=new NavigationDoors(this::bodyRef);
    private BodyPlayer bodyRef(){return body;}
    /** The caller decided the walk is over: shut the doors opened on the way that the body is out of. */
    void closeDoorsBehind(){doors.arrived();}
    private static JsonObject point(Vec3 p){return p==null?null:obj("x",p.x,"y",p.y,"z",p.z);}
    JsonObject diagnostics(){return obj("planner","vanilla-walk","plans",plans,"obstacleReplans",totalReplans,"routePoints",routePoints,"visitedLimit",visitedLimit,
        "searchMs",searchNanos/1_000_000d,"maxSearchMs",maxSearchNanos/1_000_000d,"jumped",jumped,"leaps",leaps,"ledges",ledges,"doorsOpened",doors.opened,"doorsClosed",doors.closed,"swims",swims,
        "next",route!=null&&index<route.size()?point(route.get(index)):null,"feet",point(body.position()),"motion",point(body.getDeltaMovement()),
        "onGround",body.onGround(),"stage",shore!=null?"swim":route==null?"planning":body.onGround()?"walk":"air");}

    /** Walking nodes plus one-block gap leaps, minus any node outside the caller's authorized region. */
    private static final class RouteEvaluator extends WalkNodeEvaluator {
        Predicate<Vec3> allowed=p->true;
        /** Gap leaps; a long walk goes round a gap instead (a missed leap by a cliff is a long fall). */
        boolean leaps=true;
        /**
         * Every route: never step to a BLOCKED node or drop further than the model may fall. Vanilla shares one node per
         * block and marks the block under a too-long fall BLOCKED (cost -1) even when it is already queued; it then lets a
         * node with negative cost lead to more of them, cheaper each time. With a one-block fall limit that chained whole
         * cliffs of two-block drops into a route (a long walk measured in game: 106 down to 95, fall damage); ordinary
         * walking (three-block limit) can chain the same way down a deeper cliff.
         */
        @Override public int getNeighbors(Node[] output,Node node){
            int count=super.getNeighbors(output,node);
            for(Direction direction:Direction.Plane.HORIZONTAL){
                if(count>=output.length)break;
                int x=node.x+direction.getStepX(),z=node.z+direction.getStepZ();
                boolean walkable=false; // vanilla already walks (or steps up) there: no leap
                for(int i=0;i<count;i++)if(output[i].x==x&&output[i].z==z&&output[i].y>=node.y)walkable=true;
                Node landing=walkable||!leaps?null:gapLanding(node,direction);
                if(landing!=null)output[count++]=landing;
            }
            int kept=0;
            for(int i=0;i<count;i++){
                Node next=output[i];
                if((next.type==PathType.BLOCKED||next.costMalus<0||node.y-next.y>mob.getMaxFallDistance()))continue;
                if(allowed.test(new Vec3(next.x+0.5,next.y,next.z+0.5)))output[kept++]=next;
            }
            return kept;
        }
        /**
         * The block two ahead when the one between is a gap: no floor at this level, nothing solid, burning or
         * fluid where the body passes, headroom over take-off, gap and landing, and walkable ground at the same
         * level to land on. Anything under the gap (a drop, water, lava) does not matter: the body flies over it.
         */
        private Node gapLanding(Node node,Direction direction){
            int dx=direction.getStepX(),dz=direction.getStepZ(),x=node.x,y=node.y,z=node.z;
            if(!open(x,y+2,z)||!passable(x+dx,y-1,z+dz))return null;
            for(int h=0;h<=2;h++)if(!open(x+dx,y+h,z+dz))return null;
            int lx=x+2*dx,lz=z+2*dz;
            if(!open(lx,y+2,lz)||getCachedPathType(lx,y,lz)!=PathType.WALKABLE)return null;
            double floor=getFloorLevel(new BlockPos(x,y,z)),landingFloor=getFloorLevel(new BlockPos(lx,y,lz));
            if(landingFloor>floor+0.01||landingFloor<floor-0.51)return null;
            Node landing=getNode(lx,y,lz);
            if(landing.closed)return null;
            landing.type=PathType.WALKABLE;landing.costMalus=Math.max(landing.costMalus,0);
            return landing;
        }
        /** No collision at all (the gap floor may hold a liquid). */
        private boolean passable(int x,int y,int z){
            CollisionGetter level=currentContext.level();BlockPos pos=new BlockPos(x,y,z);
            return level.getBlockState(pos).getCollisionShape(level,pos).isEmpty();
        }
        /** Room for the body: no collision, no fire or other burning block, no fluid. */
        private boolean open(int x,int y,int z){
            BlockState state=currentContext.getBlockState(new BlockPos(x,y,z));
            return passable(x,y,z)&&!isBurningBlock(state)&&state.getFluidState().isEmpty();
        }
    }
}
