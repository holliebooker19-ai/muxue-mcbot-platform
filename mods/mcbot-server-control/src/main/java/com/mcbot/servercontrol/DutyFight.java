package com.mcbot.servercontrol;

/**
 * The controller's record of a fight the guard duty is driving, and the one way it ends: the body goes back to what it was
 * taken from, and the operation that was paused (only that one) gets the fight's length added to its time limit. The fight
 * ends the same way whether the duty finished it (tickDuty) or was turned off or replaced in the middle of it (clearDuty),
 * so a task paused for the fight always plans its way again and counts damage from then on (docs/companion_state_design.md 5.2).
 */
final class DutyFight {
    /** What the end of a fight gives back. */
    interface Handback {
        /** An operation runs: its task (if it has one) plans again, with `extendMs` added to its time limit. */
        void resumeTask(long extendMs);
        /** Nothing runs: the body stands still and the posture (a follow, a seat) takes it back. */
        void resumeBody();
    }
    private boolean driving;
    private long from;
    private ControlSession.Operation paused;

    /** True from the first tick the duty drove the body until {@link #end} or {@link #reset}. */
    boolean driving(){return driving;}
    /** The duty drove the body this tick; the first one starts the fight and remembers what was running. */
    void drove(long now,ControlSession.Operation running) {
        if(!driving){from=now;paused=running;}
        driving=true;
    }
    /** An operation began between two ticks of the fight (a gathering's next step, say): it waits for the fight like a paused one. */
    void began(ControlSession.Operation operation,long now) {
        if(driving){paused=operation;from=now;}
    }
    /** Everything was stopped: no fight to end, nothing to resume. */
    void reset(){driving=false;paused=null;}
    /**
     * The fight is over (or the duty that drove it is gone). `running` is the operation now in the slot, if any. The state is
     * cleared before anything is given back, so a fault in a task's resume leaves no fight behind. False when no fight was on.
     */
    boolean end(long now,ControlSession.Operation running,Handback back) {
        if(!driving)return false;
        long fightMs=now-from;
        boolean extend=running==paused;
        driving=false;paused=null;
        if(running!=null)back.resumeTask(extend?fightMs:0);
        else back.resumeBody();
        return true;
    }
}
