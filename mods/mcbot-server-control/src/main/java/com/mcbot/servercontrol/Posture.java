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
 */
final class Posture {
    /**
     * How long the body stays free after an action before the posture takes it back. Moved here from the runtime's own
     * pause (resumeDelayMs, also 3 seconds): a model calling tools one after another leaves two or three seconds between
     * calls, and the body must not walk off in between.
     */
    static final long RESUME_AFTER_MS=3000;
    /** Actions that leave the posture driving: none of them moves the body (formerly the beside-follow list). Step 3 adds look-at and emote. */
    private static final Set<String> KEEPS=Set.of("send-chat","select-slot","equip-item");
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
    private boolean returning,ended;

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
    /** Whether this running action takes the body from the posture: not the KEEPS actions, and not what a seated body may do sitting. */
    boolean suspendedBy(String action) {
        if(KEEPS.contains(action))return false;
        return !(kind==Kind.SEATED&&NativeSeat.allowedWhileSeated(action));
    }
    /** After a fight while waiting the guard walks back to where it stood (the 10-10 rule); following and seated postures take the body back themselves. */
    boolean guardWalksBack(){return kind==Kind.WAIT;}
    /** The followed name now belongs to someone else: the posture is over (the controller drops it). */
    boolean ended(){return ended;}

    /**
     * One tick, after the guard and any operation. `running`: a running action this posture yields to, or null.
     * True when the posture drove the body this tick.
     */
    boolean tick(String running) {
        long now=view.now();
        if(!view.mayDrive()){halt();return false;}
        if(running!=null) {
            if(!"suspended".equals(state))halt();
            suspendedFor=running;resumeAt=now+RESUME_AFTER_MS;state="suspended";return false;
        }
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
        state="guarding";
    }
    /** The guard handed the body back: route again from where the fight left it. */
    void resumeAfterGuard(){if(follow!=null)follow.resume();returning=false;}
    /** An ordinary stop: movement ends now and the posture waits RESUME_AFTER_MS before it drives again (a follow shows suspended meanwhile). */
    void interrupt() {
        halt();resumeAt=view.now()+RESUME_AFTER_MS;
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
