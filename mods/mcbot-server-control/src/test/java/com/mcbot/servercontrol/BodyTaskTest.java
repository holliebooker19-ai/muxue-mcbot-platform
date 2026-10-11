package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import static com.mcbot.servercontrol.Protocol.*;

/** The shared end of a task in the slot (docs/companion_state_design.md 8.3): each failure shape the tasks declare. */
final class BodyTaskTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    /** A task with a given failure shape that records the order of stop and report. */
    private static final class FakeTask implements BodyTask {
        final List<String> calls=new ArrayList<>();
        final boolean position,stopFirst,brokenReport,declares;final String fault;
        FakeTask(boolean declares,boolean position,String fault,boolean stopFirst,boolean brokenReport){this.declares=declares;this.position=position;this.fault=fault;this.stopFirst=stopFirst;this.brokenReport=brokenReport;}
        JsonObject report(){calls.add("report");if(brokenReport)throw new IllegalStateException("broken");return obj("placed",3);}
        public void tick(){}
        public void stop(){calls.add("stop");}
        public Failure failure(){return declares?new Failure(this::report,position,fault,stopFirst):null;}
        public boolean interruptible(){return false;}
        public void resumeAfterGuard(long fightMs){}
    }
    private static final JsonObject HERE=obj("x",1.0,"y",64.0,"z",2.0);
    static void run() {
        refusals();
        faults();
        throwsUp();
        System.out.println("BodyTaskTest: "+checks+" checks passed");
    }
    private static void refusals() {
        // A station or hunt: progress, code, then where the body stands.
        FakeTask hunt=new FakeTask(true,true,"Hunt task fault",false,false);
        BodyTask.End end=BodyTask.end(hunt,error("NO_TARGET","none left"),()->HERE);
        check(end.status().equals("failed")&&end.summary().equals("NO_TARGET: none left"),"a refusal fails with its code and message");
        check(new ArrayList<>(end.result().keySet()).equals(List.of("placed","code","position"))&&end.result().get("position").equals(HERE),"progress, then code, then position, as before the slot");
        check(hunt.calls.equals(List.of("report")),"the task is not stopped here: finishing stops the slot");
        // A build or a long walk: no position in the refusal.
        FakeTask build=new FakeTask(true,false,"Build task fault",false,false);
        end=BodyTask.end(build,error("UNKNOWN","scaffold vanished"),()->HERE);
        check(end.status().equals("unknown"),"an UNKNOWN refusal ends the operation as unknown");
        check(!end.result().has("position")&&end.result().get("code").getAsString().equals("UNKNOWN"),"no position for a task that never reported one");
        // A pillar: nothing but the code and position.
        BodyTask pillar=new BodyTask(){
            public void tick(){} public void stop(){} public boolean interruptible(){return false;} public void resumeAfterGuard(long fightMs){}
            public Failure failure(){return new Failure(JsonObject::new,true,null,false);}
        };
        end=BodyTask.end(pillar,error("TIMEOUT","late"),()->HERE);
        check(end.result().equals(obj("code","TIMEOUT","position",HERE)),"the pillar's refusal is exactly code and position");
        // A station job closes its station before it reports.
        FakeTask job=new FakeTask(true,true,"Station task fault",true,false);
        BodyTask.end(job,error("NO_FUEL","empty"),()->HERE);
        check(job.calls.equals(List.of("stop","report")),"a job stops before it reports a refusal");
    }
    private static void faults() {
        FakeTask station=new FakeTask(true,true,"Workstation fault",false,false);
        BodyTask.End end=BodyTask.end(station,new IllegalStateException("bug"),()->HERE);
        check(end.status().equals("unknown"),"a fault leaves the result unknown");
        check(end.summary().equals(BodyTask.UNCERTAIN_FAULT+"Workstation fault: IllegalStateException"),"the summary warns and names the fault");
        check(end.result().get("code").getAsString().equals("INTERNAL")&&end.result().get("fault").getAsString().equals("IllegalStateException")&&end.result().get("placed").getAsInt()==3&&end.result().get("position").equals(HERE),"progress plus INTERNAL, the fault and the position");
        FakeTask broken=new FakeTask(true,false,"Farm task fault",false,true);
        end=BodyTask.end(broken,new NullPointerException(),()->null);
        check(end.result().equals(obj("code","INTERNAL","fault","NullPointerException")),"a report broken by the same fault is left out, and no position without a body");
        // The job reports first, then closes its station.
        FakeTask job=new FakeTask(true,true,"Station task fault",true,false);
        BodyTask.end(job,new IllegalStateException(),()->HERE);
        check(job.calls.equals(List.of("report","stop")),"a job reports a fault before it stops");
    }
    private static void throwsUp() {
        FakeTask travel=new FakeTask(true,false,null,false,false);
        check(BodyTask.end(travel,new IllegalStateException(),()->HERE)==null,"a task without a fault label lets a fault go up");
        check(BodyTask.end(travel,error("NO_PATH","cliff"),()->HERE)!=null,"but still ends a refusal");
        FakeTask pickup=new FakeTask(false,false,null,false,false);
        check(BodyTask.end(pickup,error("STALE_TARGET","gone"),()->HERE)==null&&BodyTask.end(pickup,new IllegalStateException(),()->HERE)==null,"a task that ends its operation itself lets everything go up");
        check(pickup.calls.isEmpty(),"and nothing is stopped or reported for it");
    }
}
