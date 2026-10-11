package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.Set;
import net.minecraft.core.BlockPos;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * The companion posture: following a player, waiting where the body is, or sitting on a seat (docs/companion_state_design.md,
 * section 7; protocol "陪伴姿态"). Not an operation: like the guard duty it belongs to the lease and the body session and
 * outlives ordinary stops. Each tick the guard goes first, then a running operation, then the posture: while an operation
 * runs the posture is suspended for it, and once the body has been free for {@link #RESUME_AFTER_MS} it drives again.
 * KEEPS actions leave it driving; HOLDS actions (a built-in gesture) only stop it moving, with no pause afterwards.
 */
final class Posture {
    /**
     * How long the body stays free after an action before the posture takes it back. Moved here from the runtime's own
     * pause (resumeDelayMs, also 3 seconds): a model calling tools one after another leaves two or three seconds between
     * calls, and the body must not walk off in between.
     */
    static final long RESUME_AFTER_MS=3000;
    /**
     * Actions that leave the posture driving: none of them moves the body (formerly the beside-follow list). look-at only turns
     * the head: a walking posture turns it back to the walking direction on its next tick, a standing one keeps the look
     * through the gaze hold (ServerController.idleGaze).
     */
    private static final Set<String> KEEPS=Set.of("send-chat","select-slot","equip-item","look-at");
    /**
     * Actions during which the posture stands still but keeps its state and gets no RESUME_AFTER_MS tail (companion_state_design.md,
     * step 3). A built-in gesture (BodyEmotes.GESTURES, about a second) turns the body's yaw, pitch and stance itself, so walking
     * would fight it; once it ends the posture drives on the next tick. An add-on animation is not a hold: it outlives its
     * operation and suspends the posture instead (yieldTo).
     */
    private static final Set<String> HOLDS=Set.of("emote");
    enum Kind {FOLLOW,WAIT,SEATED}
    interface View {
        long now();
        boolean mayDrive();
        /** Sitting on a seat now. */
        boolean seated();
        /** The vanilla dismount. */
        void standUp();
        /** One step back to the seat and onto it; true once sitting there. Throws the sit codes when it cannot. */
        boolean returnToSeat(BlockPos seat);
        void stopSeatWalk();
    }
    private Kind kind;
    final long revision;
    final FollowCompanion follow;
    final BlockPos seat;
    private final View view;
    private String state,reason,suspendedFor;
    private long resumeAt,returnSince;
    private boolean returning,ended,held;

    private Posture(Kind kind,long revision,FollowCompanion follow,BlockPos seat,View view) {
        this.kind=kind;this.revision=revision;this.follow=follow;this.seat=seat;this.view=view;
        state=switch(kind){case FOLLOW->"following";case WAIT->"waiting";case SEATED->"seated";};
    }
    static Posture follow(FollowCompanion follow,long revision,View view){return new Posture(Kind.FOLLOW,revision,follow,null,view);}
    static Posture waiting(long revision,View view){return new Posture(Kind.WAIT,revision,null,null,view);}
    /** Set by a sit that succeeded, not by the posture method; it keeps the revision of the posture it replaced. */
    static Posture seated(BlockPos seat,long revision,View view){return new Posture(Kind.SEATED,revision,null,seat,view);}

    Kind kind(){return kind;}
    /** An action that never takes the body from any posture (it does not move the body). */
    static boolean keeps(String action){return KEEPS.contains(action);}
    /** Whether this running action takes the body from the posture: not the KEEPS or HOLDS actions, and not what a seated body may do sitting. */
    boolean suspendedBy(String action) {
        if(KEEPS.contains(action)||HOLDS.contains(action))return false;
        return takesBody(action);
    }
    /** Whether the action takes the body from this posture; a seated body keeps what it may do while sitting. */
    private boolean takesBody(String action){return !(kind==Kind.SEATED&&NativeSeat.allowedWhileSeated(action));}
    /**
     * What the posture gives way to now: the first running action that takes the body, else an add-on animation still playing
     * after its emote operation finished (BodyEmotes; walking off would cut a looping animation short), else null.
     */
    String yieldTo(java.util.List<String> running,boolean animating) {
        for(String action:running) if(suspendedBy(action)) return action;
        return animating&&takesBody("emote")?"emote":null;
    }
    /**
     * Whether a running HOLDS action (a built-in gesture) keeps this posture standing still now. A seated posture never holds:
     * sitting keeps its own timing, as before.
     */
    boolean holdsFor(java.util.List<String> running) {
        if(kind==Kind.SEATED) return false;
        for(String action:running) if(HOLDS.contains(action)) return true;
        return false;
    }
    /**
     * The normal end of a KEEPS or HOLDS action: the posture is not interrupted, so there is no RESUME_AFTER_MS tail. A seated
     * posture keeps the pause its stop always had. An explicit stop never asks this (ServerController.stop).
     */
    boolean endsQuietly(String action){return kind!=Kind.SEATED&&(KEEPS.contains(action)||HOLDS.contains(action));}
    /** After a fight while waiting the guard walks back to where it stood (the 10-10 rule); following and seated postures take the body back themselves. */
    boolean guardWalksBack(){return kind==Kind.WAIT;}
    /** The followed name now belongs to someone else: the posture is over (the controller drops it). */
    boolean ended(){return ended;}

    /**
     * One tick, after the guard and any operation. `running`: a running action this posture yields to, or null; `holds`: a
     * HOLDS action is playing now ({@link #holdsFor}). True when the posture drove the body this tick.
     */
    boolean tick(String running,boolean holds) {
        long now=view.now();
        if(!view.mayDrive()){halt();held=false;return false;}
        if(running!=null) {
            if(!"suspended".equals(state))halt();
            suspendedFor=running;resumeAt=now+RESUME_AFTER_MS;state="suspended";held=false;return false;
        }
        if(holds) {
            // A gesture plays: stand still once; the state stays (a fight that just ended shows the posture's own state, not guarding), and a pause already running keeps its own clock.
            if(state.equals("guarding"))state=kind==Kind.FOLLOW?follow.state():"waiting";
            if(!held)halt();
            held=true;return false;
        }
        held=false;
        // Still in the pause after an action: an operation's suspension (or a fight just over) shows as suspended; a wait or a seat that never moved stays as it was.
        if(now<resumeAt){if(state.equals("guarding"))state="suspended";return false;}
        suspendedFor=null;
        return switch(kind) {
            case WAIT -> {state="waiting";reason=null;yield false;}
            case SEATED -> seat(now);
            case FOLLOW -> {
                if(view.seated())view.standUp();
                boolean drove;
                try {drove=follow.tick();}
                catch(Protocol.Error other) {follow.halt();ended=true;reason=other.code;yield false;}
                // An unexpected fault in one tick is not the end of following: stand still and try again next tick.
                catch(RuntimeException fault) {follow.halt();state="blocked";reason="INTERNAL";yield false;}
                state=follow.state();reason=follow.reason();yield drove;
            }
        };
    }
    /** Back to the seat after the guard stood the body up; a seat that is gone, taken or out of reach turns the posture into waiting. */
    private boolean seat(long now) {
        if(view.seated()){if(returning)view.stopSeatWalk();returning=false;state="seated";reason=null;return false;}
        if(!returning){returning=true;returnSince=now;}
        try {
            if(now-returnSince>GuardDuty.BACK_LIMIT_MS)throw error("NO_PATH","Did not get back to the seat in time");
            if(view.returnToSeat(seat)){view.stopSeatWalk();returning=false;state="seated";reason=null;return false;}
            state="seated";return true;
        } catch(RuntimeException failure) {
            view.stopSeatWalk();returning=false;
            // A block that is no longer a seat reads as STALE_TARGET from the seat check; to the runtime the seat is simply gone.
            String code=failure instanceof Protocol.Error known?known.code:"INTERNAL";
            kind=Kind.WAIT;state="waiting";reason=code.equals("STALE_TARGET")?"NO_SEAT":code;
            return false;
        }
    }
    /** The guard took the body for a fight this tick. */
    void guarding() {
        if(!"guarding".equals(state))halt();
        state="guarding";held=false;
    }
    /** The guard handed the body back: route again from where the fight left it. */
    void resumeAfterGuard(){if(follow!=null)follow.resume();returning=false;}
    /** An ordinary stop: movement ends now and the posture waits RESUME_AFTER_MS before it drives again (a follow shows suspended meanwhile). */
    void interrupt() {
        halt();held=false;resumeAt=view.now()+RESUME_AFTER_MS;
        if(kind==Kind.FOLLOW)state="suspended";
    }
    void holdStroll(){if(follow!=null)follow.holdStroll();}
    /** Stop moving; the posture stays. */
    void halt() {
        if(follow!=null)follow.standAside();
        if(returning){view.stopSeatWalk();returning=false;}
    }
    JsonObject json() {
        JsonObject result=obj("action",kind.name().toLowerCase(java.util.Locale.ROOT),"postureRevision",revision,"state",state);
        if(follow!=null&&kind==Kind.FOLLOW) {
            result.addProperty("player",follow.name);result.addProperty("entityId",follow.expected.toString());
            result.addProperty("distance",follow.distance);result.addProperty("wander",follow.wander);
            if(state.equals("following")){result.addProperty("arrived",follow.arrived());result.addProperty("strolling",follow.strolling());}
        }
        if(state.equals("suspended")) {
            if(suspendedFor!=null)result.addProperty("suspendedFor",suspendedFor);
            result.addProperty("resumeInMs",Math.max(0,resumeAt-view.now()));
        }
        if(kind==Kind.SEATED) {
            result.add("seat",obj("x",seat.getX(),"y",seat.getY(),"z",seat.getZ()));
            if(returning)result.addProperty("returning",true);
        }
        if(reason!=null)result.addProperty("reason",reason);
        return result;
    }
}
