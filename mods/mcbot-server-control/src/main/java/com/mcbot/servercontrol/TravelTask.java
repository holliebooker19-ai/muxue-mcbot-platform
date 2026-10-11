package com.mcbot.servercontrol;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * travel-to: a long walk in legs of up to LEG blocks. Each leg follows the rough way SurfaceRoute finds over the
 * ground of the loaded columns around the body (round a cliff, out of a valley, along a river to a low bank), and is
 * walked with an ordinary NativeNavigation route that settles the details; the body is a real player, so chunks
 * load around it as it goes. Where the way crosses water the body swims like a player: steps in from the bank,
 * keeps at the surface and swims along it; out of the water the next leg's navigation climbs onto a low bank.
 * A leg that fails is avoided by the next plan; when the plan has nothing (the body in a cave, under an overhang)
 * a leg is tried straight toward the destination, turned left and right, then shorter. MAX_FAILURES legs in a row
 * without getting closer than ever before fail the walk. Damage stops it, as any walk.
 */
final class TravelTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,false,null,false);}
    static final int LEG=28,MAX_FAILURES=12,MAX_SWIM_LEG=16;
    // Wide turns walk along a cliff or back out of a dead end (a cave mouth under the hill) to find a way round.
    private static final double[] TURNS={0,35,-35,70,-70,100,-100,135,-135,0,50,-50};
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final double x,z,tolerance;
    private final Double y;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final Vec3 start;
    private NativeNavigation navigation;
    private Vec3 leg;
    /** The current leg came from the surface plan (a failure there is avoided next time). */
    private boolean planned;
    /** The last planned leg failed: try the next one by turning, with the navigation that also sees caves and overhangs. */
    private boolean skipPlan;
    /** How close the ground of the last plan came to the destination when it could not reach it, or null. */
    private Double shortOf;
    private int failures,legs,swims,plans;
    /** The least horizontal distance left so far: only getting closer than this counts as progress, so walking back and swimming out again does not. */
    private double closest;
    private String lastFailure;
    /** Where the body swims to (a bank, or further along the water), or null on a walking leg. */
    private Vec3 swim;
    private double swimGap;
    private long swimSince;
    private float swimHealth;
    /** Columns of failed legs, left out of the next plans. */
    private final Set<Long> avoid=new HashSet<>();
    /** The last few legs (where to, how it ended), so a failed walk shows where it got stuck. */
    private final ArrayDeque<JsonObject> trail=new ArrayDeque<>();

    TravelTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;JsonObject args=operation.args;
        x=bounded(args,"x",0,-29_999_000,29_999_000);z=bounded(args,"z",0,-29_999_000,29_999_000);
        y=args.has("y")?bounded(args,"y",0,-2048,2048):null;
        tolerance=bounded(args,"tolerance",2,1,8);
        if(horizontal(player.position())>2000)throw error("OUT_OF_REACH","travel-to is limited to 2000 blocks");
        long timeout=(long)bounded(args,"timeoutMs",300_000,5_000,900_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);start=player.position();closest=horizontal(start);
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private double horizontal(Vec3 feet){return Math.hypot(x-feet.x,z-feet.z);}
    /** Close enough, and nothing solid between the body and the spot (a wall would mean the wrong side of it). */
    private boolean arrived(Vec3 feet) {
        if(horizontal(feet)>tolerance||y!=null&&Math.abs(feet.y-y)>3)return false;
        // Not in a doorway: the door could not be shut behind, and it is neither inside nor outside.
        var box=player.getBoundingBox().move(feet.subtract(player.position()));
        for(int bx=(int)Math.floor(box.minX);bx<=(int)Math.floor(box.maxX);bx++)for(int bz=(int)Math.floor(box.minZ);bz<=(int)Math.floor(box.maxZ);bz++)
            if(NavigationDoors.handDoor(player.serverLevel().getBlockState(new BlockPos(bx,(int)Math.floor(feet.y+0.01),bz))))return false;
        Vec3 from=feet.add(0,0.5,0),to=new Vec3(x,(y!=null?y:feet.y)+0.5,z);
        if(from.distanceTo(to)<0.3)return true;
        return player.serverLevel().clip(new ClipContext(from,to,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,player)).getType()==HitResult.Type.MISS;
    }
    JsonObject progress() {
        Vec3 feet=player.position();
        JsonObject result=obj("position",obj("x",feet.x,"y",feet.y,"z",feet.z),"remaining",horizontal(feet),"travelled",Math.hypot(feet.x-start.x,feet.z-start.z),"legs",legs,"failures",failures,"swims",swims,"plans",plans);
        if(lastFailure!=null)result.addProperty("lastFailure",lastFailure);
        if(!trail.isEmpty()){JsonArray recent=new JsonArray();trail.forEach(recent::add);result.add("recentLegs",recent);}
        return result;
    }
    /**
     * Feet height of the ground at a column, or null when its chunk is not loaded: the top of the motion-blocking
     * blocks, then down past tree trunks and leaves (a tree top is no place to walk to) and anything not solid.
     */
    private Integer surface(int bx,int bz) {
        var level=player.serverLevel();
        if(level.getChunkSource().getChunkNow(bx>>4,bz>>4)==null)return null;
        int top=level.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,bx,bz);
        BlockPos.MutableBlockPos below=new BlockPos.MutableBlockPos(bx,top-1,bz);
        for(int depth=0;depth<48&&below.getY()>level.getMinBuildHeight();depth++,below.move(0,-1,0)) {
            BlockState state=level.getBlockState(below);
            if(!state.getFluidState().isEmpty())break;
            if(!state.is(BlockTags.LOGS)&&!state.is(BlockTags.LEAVES)&&state.blocksMotion())break;
        }
        return below.getY()+1;
    }
    /** The spot of a column on the plan; the destination itself when it is that column. */
    private Vec3 spot(SurfaceRoute.Cell cell) {
        if(cell.x()==(int)Math.floor(x)&&cell.z()==(int)Math.floor(z))return new Vec3(x,y!=null?y:cell.y(),z);
        return new Vec3(cell.x()+0.5,cell.y(),cell.z()+0.5);
    }
    /**
     * The next leg along the surface plan: walk up to LEG blocks of it, or to the bank where it enters water; at the
     * water (or in it) swim up to MAX_SWIM_LEG blocks along it or to where it comes out. False when the plan has
     * nothing for this spot: the body is not on the surface (a cave, an overhang) or no way gets closer.
     */
    private boolean planLeg(Vec3 feet) {
        int fx=(int)Math.floor(feet.x),fz=(int)Math.floor(feet.z);
        SurfaceRoute grid=SurfaceRoute.sample(player.serverLevel(),fx,fz);plans++;
        int here=grid.index(fx,fz);
        if(!player.isInWater()&&Math.abs(grid.height[here]-feet.y)>1.5)return false;
        for(long cell:avoid){int i=grid.index((int)(cell>>32),(int)cell);if(i>=0&&i!=here)grid.kind[i]=SurfaceRoute.BLOCKED;}
        List<SurfaceRoute.Cell> way=grid.plan(fx,fz,x,z);
        if(way.size()<2)return false;
        SurfaceRoute.Cell end=way.getLast();
        shortOf=null;
        if(end.x()!=(int)Math.floor(x)||end.z()!=(int)Math.floor(z)) {
            shortOf=horizontal(spot(end));
            // Already where the ground of the plan comes closest: nothing more to follow on it.
            if(Math.hypot(end.x()+0.5-feet.x,end.z()+0.5-feet.z)<=4)return false;
        }
        double along=0;
        for(int i=1;i<way.size();i++) {
            SurfaceRoute.Cell from=way.get(i-1),cell=way.get(i);
            along+=Math.hypot(cell.x()-from.x(),cell.z()-from.z());
            if(cell.kind()==SurfaceRoute.WATER) {
                if(from.kind()==SurfaceRoute.LAND&&along>4){walkTo(spot(from));return true;} // to the bank first
                // Swim: along the water up to MAX_SWIM_LEG blocks, or to the first land after it.
                int j=i;double swum=0;
                while(j+1<way.size()&&way.get(j).kind()==SurfaceRoute.WATER&&swum<MAX_SWIM_LEG){swum+=Math.hypot(way.get(j+1).x()-way.get(j).x(),way.get(j+1).z()-way.get(j).z());j++;}
                Vec3 to=spot(way.get(j));
                // A bank right there is climbed onto by the navigation, which swims to a low enough spot of it.
                if(Math.hypot(to.x-feet.x,to.z-feet.z)<=3.5)walkTo(to);else startSwim(feet,to);
                return true;
            }
            if(along>=LEG||i==way.size()-1){walkTo(spot(cell));return true;}
        }
        return false;
    }
    private void walkTo(Vec3 target){leg=target;planned=true;}
    private void startSwim(Vec3 feet,Vec3 target) {
        swim=target;swimGap=Math.hypot(target.x-feet.x,target.z-feet.z);swimSince=now();swimHealth=player.getHealth();
        legs++;swims++;
    }
    /** Without a plan: straight toward the destination, turned further after each failure, then shorter. */
    private Vec3 pickLeg(Vec3 feet) {
        double remaining=horizontal(feet);
        // Straight at the destination itself when it is near, unless that has just failed: then go round like any leg.
        if(remaining<=LEG&&TURNS[failures%TURNS.length]==0) {
            Integer top=surface((int)Math.floor(x),(int)Math.floor(z));
            if(top!=null)return new Vec3(x,y!=null?y:top,z);
        }
        double angle=Math.atan2(z-feet.z,x-feet.x)+Math.toRadians(TURNS[failures%TURNS.length]);
        for(double length=Math.min(LEG,remaining)*(failures>=TURNS.length/2+1?0.6:1);length>=6;length-=6) {
            double lx=feet.x+Math.cos(angle)*length,lz=feet.z+Math.sin(angle)*length;
            Integer top=surface((int)Math.floor(lx),(int)Math.floor(lz));
            if(top!=null&&Math.abs(top-feet.y)<=24)return new Vec3(Math.floor(lx)+0.5,top,Math.floor(lz)+0.5);
        }
        return null;
    }
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(now()>=deadline)throw error("TIMEOUT","Travel time limit reached before the destination");
        Vec3 feet=player.position();
        if(player.onGround()&&arrived(feet)){player.stopInput();if(navigation!=null)navigation.closeDoorsBehind();operation.finish("succeeded","Arrived",progress());return;}
        if(swim!=null){swimTick(feet);return;}
        if(navigation==null) {
            if(!player.onGround()&&!player.isInWater())return;
            NativeNavigation.conditions(player);
            if(skipPlan||!planLeg(feet)) {
                skipPlan=false;planned=false;leg=pickLeg(feet);
                if(leg==null){fail(feet,"no loaded surface toward the destination");return;}
            }
            if(swim!=null)return;
            navigation=new NativeNavigation(player,session,operation).wide();legs++;
        }
        Vec3 target=leg;boolean last=Math.hypot(target.x-x,target.z-z)<0.01;
        try {
            boolean done=navigation.tick(target,f->last?arrived(f):Math.hypot(f.x-target.x,f.z-target.z)<=2.5&&Math.abs(f.y-target.y)<=4);
            if(!done)return;
        } catch(Protocol.Error failure) {
            if(failure.getMessage()!=null&&failure.getMessage().contains("damage"))throw failure;
            if(!failure.code.equals("NO_PATH")&&!failure.code.equals("BLOCKED"))throw failure;
            navigation.stop();navigation=null;
            if(planned)avoidPlanned(target);
            fail(feet,failure.code+": "+failure.getMessage());
            return;
        }
        navigation.closeDoorsBehind();navigation.stop();navigation=null;
        if(closer(player.position()))note(leg,"walked");
        else{if(planned)avoidPlanned(leg);fail(player.position(),"leg made no progress");}
    }
    private void avoidPlanned(Vec3 spot){avoidAround(spot);skipPlan=true;}
    private void avoidAround(Vec3 spot) {
        int cx=(int)Math.floor(spot.x),cz=(int)Math.floor(spot.z);
        for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++)avoid.add(((long)(cx+dx)<<32)|((cz+dz)&0xffffffffL));
    }
    /** Closer than ever before by more than two blocks: progress, which forgives the failures so far. */
    private boolean closer(Vec3 feet) {
        double left=horizontal(feet);
        if(left>=closest-2)return false;
        closest=left;failures=0;return true;
    }
    private void note(Vec3 to,String outcome) {
        Vec3 feet=player.position();
        JsonObject entry=obj("at",obj("x",Math.floor(feet.x),"y",Math.floor(feet.y),"z",Math.floor(feet.z)),"outcome",outcome);
        if(to!=null)entry.add("to",obj("x",Math.floor(to.x),"y",Math.floor(to.y),"z",Math.floor(to.z)));
        trail.addLast(entry);
        while(trail.size()>8)trail.removeFirst();
    }
    /**
     * Swim straight at the target: hold jump in the water to stay at the surface (and to hop a step on the way in).
     * Close to it the leg ends; the next leg swims on, or its navigation climbs out onto a bank.
     */
    private void swimTick(Vec3 feet) {
        NativeNavigation.conditions(player);
        if(player.getHealth()<swimHealth){player.stopInput();throw error("BLOCKED","Body took damage while crossing water");}
        double gap=Math.hypot(swim.x-feet.x,swim.z-feet.z);
        if(gap<=3||!player.isInWater()&&player.onGround()&&gap<=4.5){
            player.stopInput();
            if(closer(feet))note(swim,"swam");else{avoidPlanned(swim);fail(feet,"swim made no progress");}
            swim=null;
            return;
        }
        if(gap<swimGap-0.3){swimGap=gap;swimSince=now();}
        else if(now()-swimSince>4000){player.stopInput();avoidPlanned(swim);fail(feet,"swim made no progress");swim=null;return;}
        Vec3 delta=swim.subtract(feet);
        player.sprintInput(false);
        player.jumpInput(player.isInWater()||player.onGround()&&player.horizontalCollision);
        player.moveInput(delta.x,delta.z,1);
    }
    private void fail(Vec3 feet,String why) {
        lastFailure=why;note(swim!=null?swim:leg,why);
        if(++failures>MAX_FAILURES)throw error("NO_PATH","No way found toward the destination ("+why+")"
            +(shortOf!=null?String.format("; the walkable ground around comes only within %.0f blocks of it",shortOf):""));
    }
    /** Walking a leg on the ground; not while swimming across water. */
    @Override public boolean interruptible(){return swim==null&&player.onGround()&&!player.isInWater();}
    @Override public void resumeAfterGuard(long fightMs){if(navigation!=null){navigation.reset();navigation.rebaseHealth();}deadline+=grace.grant(fightMs);}
    @Override public void stop(){if(navigation!=null)navigation.stop();navigation=null;swim=null;player.stopInput();}
}
