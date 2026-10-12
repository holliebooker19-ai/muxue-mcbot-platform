package com.mcbot.servercontrol;

import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import java.util.function.Predicate;
import net.minecraft.world.phys.shapes.*;
import static com.mcbot.servercontrol.Protocol.*;

final class ApproachSafetyTest {
    private static int checks;
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action) {
        checks++;try {action.run();throw new AssertionError("Expected "+code);}
        catch(Protocol.Error failure) {if(!failure.code.equals(code))throw failure;}
    }
    static void run() {
        Object first=new Object(),second=new Object(),replacement=new Object();
        var a=new TargetTokens.Part(BlockPos.ZERO,null,first);
        var b=new TargetTokens.Part(BlockPos.ZERO.east(),null,second);
        check(TargetTokens.sameParts(List.of(a),List.of(a)),"same container identity remains valid independent of inventory contents");
        check(!TargetTokens.sameParts(List.of(a),List.of(new TargetTokens.Part(BlockPos.ZERO,null,replacement))),"same-position same-state replacement rejected");
        check(!TargetTokens.sameParts(List.of(a,b),List.of(a,new TargetTokens.Part(BlockPos.ZERO.east(),null,replacement))),"double chest other-half replacement rejected");
        check(!TargetTokens.sameParts(List.of(a,b),List.of(a)),"double chest half unloaded/removed rejected");
        check(!TargetTokens.sameParts(List.of(a),List.of(new TargetTokens.Part(BlockPos.ZERO.east(),null,first))),"same object at changed position rejected");
        var target=new TargetTokens.Target("session",2,"overworld",BlockPos.ZERO,List.of(a),100);
        check(TargetTokens.validContext(target,"session",2,"overworld",99),"live token context accepted");
        check(!TargetTokens.validContext(target,"session",2,"overworld",100),"expiry boundary rejects token");
        check(!TargetTokens.validContext(target,"new",2,"overworld",1),"session replacement rejects token");
        check(!TargetTokens.validContext(target,"session",3,"overworld",1),"stop generation rejects old token");
        check(!TargetTokens.validContext(target,"session",2,"nether",1),"dimension change rejects old token");
        check(!TargetTokens.validContext(null,"session",2,"overworld",1),"unknown token rejected");

        var origin=new FlatRoute.Cell(0,0);var destination=new FlatRoute.Cell(4,0);
        Set<FlatRoute.Cell> wall=Set.of(new FlatRoute.Cell(2,-1),new FlatRoute.Cell(2,0),new FlatRoute.Cell(2,1));
        List<FlatRoute.Cell> route=FlatRoute.plan(origin,new FlatRoute.View() {
            public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to) {return !wall.contains(to)&&Math.abs(to.x())<=6&&Math.abs(to.z())<=4;}
            public boolean goal(FlatRoute.Cell cell) {return cell.equals(destination);}
        });
        check(route.getFirst().equals(origin)&&route.getLast().equals(destination),"flat obstacle route reaches selected interaction stand");
        check(route.size()==9&&route.stream().noneMatch(wall::contains),"bounded shortest route goes around wall without crossing its collision cells");
        for(int i=1;i<route.size();i++) check(Math.abs(route.get(i).x()-route.get(i-1).x())+Math.abs(route.get(i).z()-route.get(i-1).z())==1,"route uses level cardinal neighbours only");
        errorCode("NO_PATH",()->FlatRoute.plan(origin,new FlatRoute.View() {
            public boolean edge(FlatRoute.Cell a,FlatRoute.Cell b) {return false;}
            public boolean goal(FlatRoute.Cell c) {return false;}
        }));
        errorCode("PATH_BUDGET",()->FlatRoute.plan(origin,new FlatRoute.View() {
            public boolean edge(FlatRoute.Cell a,FlatRoute.Cell b) {return true;}
            public boolean goal(FlatRoute.Cell c) {return false;}
        }));
        check(FlatRoute.plan(origin,new FlatRoute.View() {
            public boolean edge(FlatRoute.Cell a,FlatRoute.Cell b) {throw new AssertionError("Already reached must not search");}
            public boolean goal(FlatRoute.Cell c) {return true;}
        }).size()==1,"already in reach has no moving route");

        VoxelShape sole=Shapes.create(new AABB(0.2,0.975,0.2,0.8,0.999,0.8));
        check(FlatApproach.supported(sole,Shapes.block()),"full sole on full block supported");
        check(!FlatApproach.supported(sole,Shapes.create(new AABB(0.4,0,0.4,0.6,1,0.6))),"center support alone cannot authorize a whole foot crossing void");
        VoxelShape left=Shapes.create(new AABB(0,0,0,0.5,1,1)),right=Shapes.create(new AABB(0.5,0,0,1,1,1));
        check(FlatApproach.supported(sole,Shapes.or(left,right)),"adjacent collision shapes together support full sole");
        check(!FlatApproach.supported(sole,Shapes.create(new AABB(0,0,0,1,0.5,1))),"half slab below requested flat feet not full support");
        AABB swept=new AABB(0.2,1,0.2,1.8,2.8,0.8);
        check(FlatApproach.collides(swept,Shapes.create(new AABB(0.9,1,0.7,1,2,1))),"body edge collision detected despite clear coordinate center");
        check(!FlatApproach.collides(swept,Shapes.block()),"floor merely touching body bottom is not body collision");
        // Native block interaction measures eye-to-hit distance. A real face point at
        // an oblique angle can be barely reachable from a grid centre while a tolerated
        // feet position 0.14 blocks short remains outside the same unchanged range.
        Vec3 faceHit=new Vec3(8,2.62,3.3),bareStand=new Vec3(4.5,1,0.5),shortStand=bareStand.add(-0.14,0,0);
        Predicate<Vec3> blockReach=feet->feet.add(0,1.62,0).distanceTo(faceHit)<=4.5;
        check(blockReach.test(bareStand)&&!blockReach.test(shortStand)&&shortStand.distanceTo(bareStand)<0.15,"block reach boundary reproduces early route exhaustion at old tolerated endpoint");
        check(!FlatApproach.arrivalStand(bareStand,blockReach),"resource/container plan cannot select a barely reachable cell");
        List<FlatRoute.Cell> blockRoute=FlatRoute.plan(new FlatRoute.Cell(4,0),new FlatRoute.View(){
            public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to){return true;}
            public boolean goal(FlatRoute.Cell cell){return FlatApproach.arrivalStand(new Vec3(cell.x()+0.5,1,cell.z()+0.5),blockReach);}
        });
        check(blockRoute.getLast().equals(new FlatRoute.Cell(5,0)),"resource/container route ends at a stand with native interaction margin");
        Vec3 safeStand=new Vec3(5.5,1,0.5);
        for(double x:new double[]{-0.149,0,0.149})for(double z:new double[]{-0.149,0,0.149})check(blockReach.test(safeStand.add(x,0,z)),"every resource/container waypoint tolerance corner keeps original native block reach");
        Predicate<Vec3> cornerOccluded=feet->blockReach.test(feet)&&feet.z<=0.6;
        check(cornerOccluded.test(safeStand)&&!FlatApproach.arrivalStand(safeStand,cornerOccluded),"centre-only line of sight cannot authorize an arrival square with an occluded corner");

        Vec3 recipient=new Vec3(5.79,1,0.5);double requestedDistance=1.3;
        Predicate<Vec3> playerReach=feet->feet.distanceTo(recipient)<=requestedDistance;
        check(playerReach.test(bareStand)&&!playerReach.test(shortStand)&&!FlatApproach.arrivalStand(bareStand,playerReach),"player approach keeps requested distance and rejects its barely reachable endpoint");
        List<FlatRoute.Cell> playerRoute=FlatRoute.plan(new FlatRoute.Cell(4,0),new FlatRoute.View(){
            public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to){return new Vec3(to.x()+0.5,1,to.z()+0.5).distanceTo(recipient)>=0.65;}
            public boolean goal(FlatRoute.Cell cell){return FlatApproach.arrivalStand(new Vec3(cell.x()+0.5,1,cell.z()+0.5),playerReach);}
        });
        Vec3 playerStand=new Vec3(playerRoute.getLast().x()+0.5,1,playerRoute.getLast().z()+0.5);
        check(FlatApproach.arrivalStand(playerStand,playerReach)&&playerStand.distanceTo(recipient)>=0.65,"player route chooses an interior requested-distance stand around real player collision");
        for(double x:new double[]{-0.149,0,0.149})for(double z:new double[]{-0.149,0,0.149})check(playerReach.test(playerStand.add(x,0,z)),"player endpoint tolerance never relaxes the originally requested distance");
        check(!FlatApproach.arrivalStand(safeStand,feet->false),"arrival margin never overrides denied reach or line of sight");
        Vec3 start=new Vec3(0,64,0),body=new Vec3(3,64,0);
        check(FlatApproach.recipientProblem(false,start,start.add(0.4,0,0),body)==null,"fixed approach tolerates a small shift");
        check("TARGET_MOVED".equals(FlatApproach.recipientProblem(false,start,start.add(2,0,0),body)),"fixed approach still fails once the player walked off");
        check(FlatApproach.recipientProblem(true,start,start.add(6,0,0),body)==null,"tracking approach follows a walking player");
        check("OUT_OF_REACH".equals(FlatApproach.recipientProblem(true,start,body.add(33,0,0),body)),"tracking approach gives up beyond the navigation range");
        AtomicLong time=new AtomicLong();
        final ControlSession.Operation[] driving={null};
        ControlSession.Game game=new ControlSession.Game() {
            public boolean connected() {return true;}
            public void ensureBody() {}
            public JsonObject hello() {return obj("capabilities",List.of("approach-container","approach-player"));}
            public JsonObject observe(JsonObject p) {return obj();}
            public JsonObject watch() {return obj();}
            public long chatCursor() {return 0;}
            public void begin(ControlSession.Operation op) {driving[0]=op;}
            public void abort(ControlSession.Operation op) {if(driving[0]==op)driving[0]=null;}
            public void stop() {driving[0]=null;}
        };
        ControlSession session=new ControlSession(game,time::get,"world","Bot");
        JsonObject claim=session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","Bot","controllerId","controller"));
        JsonObject auth=obj("instanceId",session.instanceId,"sessionId",claim.get("sessionId"),"leaseId",claim.get("leaseId"));
        JsonObject act=auth.deepCopy();act.addProperty("operationId",UUID.randomUUID().toString());act.add("controlGeneration",claim.get("controlGeneration"));act.addProperty("name","approach-container");act.add("args",obj("targetToken","token"));
        check(session.call("act",act).get("status").getAsString().equals("running"),"approach participates in session asynchronous operation lifecycle");
        ControlSession.Operation old=driving[0];session.call("stop",auth);
        check(driving[0]==null&&old.status.equals("cancelled")&&!session.mayDrive(old),"stop cancels approach and prevents old route input");
        act.addProperty("operationId",UUID.randomUUID().toString());act.addProperty("controlGeneration",session.generation());act.addProperty("name","approach-player");act.add("args",obj("player","muxue"));
        check(session.call("act",act).get("status").getAsString().equals("running"),"new approach works after stop");
        ControlSession.Operation fresh=driving[0];time.set(ControlSession.TTL_MS);session.expire();
        check(driving[0]==null&&fresh.status.equals("cancelled")&&!session.mayDrive(fresh),"lease expiry clears new approach and its input");
        System.out.println("ApproachSafetyTest: "+checks+" checks passed");
    }
}
