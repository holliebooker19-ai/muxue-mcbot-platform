package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.function.Supplier;

/**
 * What the body runs for the current operation (docs/companion_state_design.md 8.3). ServerController keeps one slot of
 * these instead of a field per kind of task and drives it each tick; the guard duty pauses it through
 * {@link GuardDuty.Pausable}. A task that ends its operation itself only finishes it; the controller then stops the slot.
 */
interface BodyTask extends GuardDuty.Pausable {
    /** One server tick; may finish the operation, or throw for the controller to end it as {@link #failure()} says. */
    void tick();
    /** Called once the operation ended or was stopped: release the menu, input and routes the task holds. */
    void stop();
    /** How a failure thrown by tick ends the operation; null: the task never throws for it, and anything thrown goes up. */
    Failure failure();

    /**
     * The shape a failed tick's result has, as each task's own branch had it before the slot: report is the progress
     * put into the result, position adds where the body stands, fault labels a RuntimeException that then ends the
     * operation as unknown (null: it goes up), stopFirst stops the task before reporting a refusal (a station job).
     * Not unified across tasks yet (8.3): changing a shape changes what the model reads.
     */
    record Failure(Supplier<JsonObject> report,boolean position,String fault,boolean stopFirst) {}
    /** How the operation ends. */
    record End(String status,String summary,JsonObject result) {}

    String UNCERTAIN_FAULT="Result uncertain: native calls may already have moved items. Observe the inventory and station before acting; do not retry blindly. ";

    /**
     * The end of an operation whose task threw from tick, in the shape the task declares; null when the throw goes up
     * instead. position is where the body stands (null when there is no body).
     */
    static End end(BodyTask task,RuntimeException thrown,Supplier<JsonObject> position) {
        Failure failure=task.failure();
        if(thrown instanceof Protocol.Error refused) {
            if(failure==null) return null;
            if(failure.stopFirst()) task.stop();
            JsonObject result=failure.report().get();result.addProperty("code",refused.code);
            if(failure.position()) result.add("position",position.get());
            return new End(refused.code.equals("UNKNOWN")?"unknown":"failed",refused.code+": "+refused.getMessage(),result);
        }
        if(failure==null||failure.fault()==null) return null;
        JsonObject result=faultResult(thrown,failure.report(),position);
        if(failure.stopFirst()) task.stop();
        return new End("unknown",UNCERTAIN_FAULT+failure.fault()+": "+thrown.getClass().getSimpleName(),result);
    }
    /** A fault in the middle of a tick: the progress report is best effort, since the same fault may break it too. */
    private static JsonObject faultResult(RuntimeException fault,Supplier<JsonObject> detail,Supplier<JsonObject> position) {
        JsonObject result;
        try{result=detail.get();}catch(RuntimeException ignored){result=null;}
        if(result==null)result=new JsonObject();
        result.addProperty("code","INTERNAL");result.addProperty("fault",fault.getClass().getSimpleName());
        JsonObject at=position.get();
        if(at!=null)result.add("position",at);
        return result;
    }
}
