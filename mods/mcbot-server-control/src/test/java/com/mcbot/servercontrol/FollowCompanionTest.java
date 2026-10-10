package com.mcbot.servercontrol;

import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** The follow posture's walking (FollowCompanion) on a scripted body: arrive, wait, stroll, away, blocked, someone else. */
final class FollowCompanionTest {
    private static int checks;
    static final UUID TARGET=UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    /** Walks straight at the player or a stroll spot, 0.22 blocks per tick. */
    static class Terrain implements FollowCompanion.View {
        final AtomicLong time=new AtomicLong();
        final Object dimension=new Object();
        Object targetDimension=dimension;
        UUID uuid=TARGET;
        Vec3 feet=new Vec3(0.5,1,0.5),target=new Vec3(6.5,1,0.5),input;
        boolean online=true,walkable=true,noPath,noSpot;
        int moves,stops,cancels,resets,strollTicks,strollEnds;
        public void refresh() {if(!walkable)throw error("BLOCKED","Body cannot walk");}
        public Vec3 position() {return feet;}
        public Object dimension() {return dimension;}
        public FollowCompanion.Target target(String name) {return new FollowCompanion.Target(uuid,targetDimension,target,online);}
        public boolean navigate(Vec3 destination,double distance) {
            if(noPath)throw error("NO_PATH","No route");
            if(feet.distanceTo(destination)<=distance){input=null;return true;}
            moves++;input=destination.subtract(feet);return false;
        }
        public void cancelNavigation() {cancels++;input=null;}
        public void stop() {stops++;input=null;}
        public Vec3 strollPoint(Vec3 centre) {return noSpot?null:centre.add(0,0,3.5);}
        public boolean stroll(Vec3 point,Vec3 centre) {
            strollTicks++;
            if(feet.subtract(point).horizontalDistance()<=0.6){input=null;return true;}
            input=point.subtract(feet);return false;
        }
        public void endStroll() {strollEnds++;}
        public void resetNavigation() {resets++;}
        void physics() {if(input!=null)feet=feet.add(new Vec3(input.x,0,input.z).normalize().scale(Math.min(0.22,input.horizontalDistance())));}
    }
    private static final class Fixture {
        final Terrain terrain=new Terrain();
        final FollowCompanion follow;
        Fixture() {this(true);}
        Fixture(boolean wander) {follow=new FollowCompanion("muxue",TARGET,2.5,wander,terrain,terrain.time::get,new Random(7));}
        boolean tick(long elapsed) {terrain.time.addAndGet(elapsed);boolean drove=follow.tick();terrain.physics();return drove;}
        void arrive() {for(int i=0;i<80&&!follow.arrived();i++)tick(50);}
    }
    static void run() {
        Fixture steady=new Fixture();
        check(steady.tick(50)&&steady.follow.state().equals("following")&&!steady.follow.arrived()&&steady.terrain.input!=null,"far from the player: walks toward them");
        steady.arrive();
        check(steady.follow.arrived()&&steady.follow.state().equals("following")&&steady.terrain.input==null,"beside the player: arrived, standing");
        check(!steady.tick(50),"standing beside the player is not driving (the controller lets the head look around)");
        steady.terrain.target=steady.terrain.target.add(5,0,0);
        check(steady.tick(50)&&!steady.follow.arrived()&&steady.terrain.input!=null,"the player walks off: follows again");

        Fixture away=new Fixture();away.arrive();
        away.terrain.online=false;
        check(!away.tick(50)&&away.follow.state().equals("away")&&"PLAYER_AWAY".equals(away.follow.reason())&&away.terrain.input==null,"player offline: away, standing still, not ended");
        away.terrain.online=true;away.terrain.target=away.terrain.target.add(5,0,0);
        check(away.tick(50)&&away.follow.state().equals("following")&&away.follow.reason()==null,"player back: follows again by itself");
        away.terrain.targetDimension=new Object();away.tick(50);
        check(away.follow.state().equals("away"),"player in another dimension: away");
        away.terrain.targetDimension=away.terrain.dimension;away.terrain.target=new Vec3(away.terrain.feet.x+GuardDuty.PLAYER_RANGE+1,1,0.5);away.tick(50);
        check(away.follow.state().equals("away"),"player beyond the protocol's 32 blocks: away");

        Fixture other=new Fixture();other.tick(50);other.terrain.uuid=UUID.fromString("00000000-0000-4000-8000-000000000002");
        checks++;
        try {other.follow.tick();throw new AssertionError("someone else behind the name must end the follow");}
        catch(Protocol.Error ended) {check(ended.code.equals("STALE_TARGET"),"someone else behind the name: STALE_TARGET");}

        Fixture blocked=new Fixture();blocked.terrain.noPath=true;
        check(!blocked.tick(50)&&blocked.follow.state().equals("blocked")&&"NO_PATH".equals(blocked.follow.reason()),"no route: blocked with NO_PATH");
        blocked.terrain.noPath=false;
        check(!blocked.tick(FollowCompanion.UNREACHABLE_RETRY_MS-100)&&blocked.follow.state().equals("blocked")&&blocked.terrain.moves==0,"blocked: waits before trying again");
        check(blocked.tick(200)&&blocked.follow.state().equals("following"),"after the retry pause it walks again");
        Fixture moved=new Fixture();moved.terrain.noPath=true;moved.tick(50);moved.terrain.noPath=false;
        moved.terrain.target=moved.terrain.target.add(0,0,FollowCompanion.UNREACHABLE_SHIFT+0.5);
        check(moved.tick(50)&&moved.follow.state().equals("following"),"the player moving off the unreachable spot: tries at once");
        Fixture lava=new Fixture();lava.terrain.walkable=false;
        check(!lava.tick(50)&&lava.follow.state().equals("blocked")&&"BLOCKED".equals(lava.follow.reason()),"cannot walk now (in lava, riding): blocked, not ended");

        Fixture aside=new Fixture();aside.tick(50);
        int cancels=aside.terrain.cancels;aside.follow.standAside();
        check(aside.terrain.input==null&&aside.terrain.cancels==cancels+1,"standing aside stops walking now");
        int resets=aside.terrain.resets;aside.follow.resume();
        check(aside.terrain.resets==resets+1&&aside.tick(50),"resuming plans a fresh route and walks");
        stroll();
        System.out.println("FollowCompanionTest: "+checks+" checks passed");
    }
    /** Idle stroll while standing by a still player: late, short, stays put until the player moves. */
    private static void stroll() {
        Fixture f=new Fixture();Terrain t=f.terrain;f.arrive();
        for(int i=0;i<7;i++)f.tick(1000);
        check(t.strollTicks==0&&!f.follow.strolling(),"no stroll in the first 8 seconds beside the player");
        long waited=7_000;
        while(!f.follow.strolling()&&waited<25_000){f.tick(500);waited+=500;}
        check(f.follow.strolling()&&waited>=8_000&&waited<=18_500,"a stroll starts 8..18 seconds after the player stood still");
        check(f.follow.state().equals("following")&&f.follow.arrived(),"strolling is still following, arrived");
        Vec3 spot=t.target.add(0,0,3.5);
        for(int i=0;i<60&&f.follow.strolling();i++)check(f.tick(50)||!f.follow.strolling(),"strolling drives the body");
        check(!f.follow.strolling()&&t.feet.subtract(spot).horizontalDistance()<=0.6&&t.strollEnds>=1,"walks to the stroll spot and ends the stroll");
        Vec3 rested=t.feet;int moves=t.moves;
        for(int i=0;i<7;i++)f.tick(1000);
        check(t.feet.equals(rested)&&t.moves==moves,"stays at the stroll spot instead of walking back while the player stands still");
        for(int i=0;i<40&&!f.follow.strolling();i++)f.tick(1000);
        check(f.follow.strolling(),"strolls again later");
        f.follow.holdStroll();
        check(!f.follow.strolling()&&t.input==null,"someone speaking stops the stroll where it is");
        f.tick(50);
        check(!f.follow.strolling(),"after speech it rests, not strolls straight away");
        t.target=t.target.add(6,0,0);
        check(f.tick(50)&&t.input!=null,"player moving off ends the rest and follows again");

        Fixture slow=new Fixture();slow.arrive();
        while(!slow.follow.strolling())slow.tick(1000);
        Vec3 start=slow.terrain.feet;int ends=slow.terrain.strollEnds;
        for(int i=0;i<12;i++){slow.tick(1000);slow.terrain.feet=start;}
        check(!slow.follow.strolling()&&slow.terrain.strollEnds>ends,"an unreached stroll ends within its time limit");
        Fixture still=new Fixture(false);still.arrive();
        for(int i=0;i<200;i++)still.tick(1000);
        check(still.terrain.strollTicks==0,"wander false never strolls");
        Fixture none=new Fixture();none.terrain.noSpot=true;none.arrive();
        for(int i=0;i<120;i++)none.tick(1000);
        check(none.terrain.strollTicks==0&&none.follow.arrived(),"no standable spot nearby: keeps standing by");
    }
}
