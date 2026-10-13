package com.mcbot.servercontrol;

import java.util.Set;

/**
 * An interrupt window (capability task-interrupts, docs/companion_state_design.md 8.4): the runtime eats or defends
 * while the running task is paused, not cancelled. The task is not ticked and keeps its operation running; afterwards it
 * plans its way again from where the body stands and gets the paused time added to its limit, from the same Grace
 * budget as the guard's fights. A window opens only at the moments the guard may take the body for a fight.
 */
final class TaskInterrupt {
    /** What SurvivalTasks sends to eat or defend; nothing else runs beside a paused task. */
    static final Set<String> STEPS=Set.of("select-slot","swap-inventory","eat-item","defend-entity","retreat-from-entity");
    static final Set<String> REASONS=Set.of("eat","defend");
    final String reason;
    /** The operation paused and the task that drives it; both null when the body was idle. */
    final ControlSession.Operation paused;
    final BodyTask task;
    private final long openedAt;
    private long lastStep;
    TaskInterrupt(String reason,ControlSession.Operation paused,BodyTask task,long now) {
        this.reason=reason;this.paused=paused;this.task=task;openedAt=lastStep=now;
    }
    /**
     * The pickup task a native pickup event is for: the one in the slot, else the one paused in the open window. The body
     * stands still in a window while vanilla collects the drop it was walking to, so the pickup task there must hear about
     * it (else it resumes to a gone drop and reports PICKUP_UNKNOWN instead of the pickup or PICKUP_TAKEN). The slot is free
     * in a window, so at most one of the two is a pickup and nothing is counted twice. Null when neither is a pickup.
     */
    static PickupItem pickupOf(BodyTask slot,TaskInterrupt window) {
        if(slot instanceof PickupItem pickup)return pickup;
        return window!=null&&window.task instanceof PickupItem pickup?pickup:null;
    }
    /**
     * Why a window cannot open now, or null: the same rule as the guard's (ServerController.dutyMayInterrupt), and never
     * while the guard drives the body (it hands the body back first, then the next try opens).
     */
    static String refusal(boolean guardFighting,boolean bodyFree,boolean running,boolean interruptible) {
        if(guardFighting)return "The guard is fighting or walking back; it hands the body back first";
        if(!bodyFree)return "Eating, digging, defending, an open menu or an item in use holds the body";
        if(running&&!interruptible)return "The running action cannot pause at this moment (off the ground, mid-dig, at a station) or never pauses";
        return null;
    }
    /**
     * One tick: while an eating or defense step runs the window stays; with none for the lease TTL (the controller lost
     * track of it, as a controller that stops sending heartbeats does) it is due to close.
     */
    boolean expired(boolean stepRunning,long now) {
        if(stepRunning)lastStep=now;
        return now-lastStep>=ControlSession.TTL_MS;
    }
    long pausedMs(long now){return Math.max(0,now-openedAt);}
}
