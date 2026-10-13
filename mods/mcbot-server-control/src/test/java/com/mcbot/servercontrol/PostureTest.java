package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * The companion posture through the protocol (posture method, stop, clearPosture) with the real session, and a game that
 * ticks like ServerController.beforePhysics: guard first, then a running operation, then the posture.
 */
final class PostureTest {
    private static int checks;
    private static void check(boolean ok,String message) {checks++;if(!ok)throw new AssertionError(message);}
    private static final class Fixture implements ControlSession.Game {
        final FollowCompanionTest.Terrain terrain=new FollowCompanionTest.Terrain();
        final ControlSession session=new ControlSession(this,terrain.time::get,"world","Bot");
        final JsonObject auth;
        Posture posture;
        boolean immediate=true,fighting,wasFighting,seated,standUps,animating;
        int seatSteps,seatWalkStops,seatBusy;
        String seatFailure,busyCode="BUSY";
        ControlSession.Operation active;
        long revision;
        Fixture() {
            JsonObject claim=session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","Bot","controllerId","c"));
            auth=obj("instanceId",session.instanceId,"sessionId",claim.get("sessionId"),"leaseId",claim.get("leaseId"));
        }
        public boolean connected() {return true;}
        public void ensureBody() {}
        public JsonObject hello() {return obj("capabilities",ServerController.CAPABILITIES);}
        public JsonObject observe(JsonObject p) {return obj();}
        public JsonObject watch() {return obj();}
        public long chatCursor() {return 0;}
        public void begin(ControlSession.Operation op) {if(immediate)op.finish("succeeded","Done",null);else active=op;}
        public void abort(ControlSession.Operation op) {if(active==op)stop();}
        // As ServerController.stop: the operation ends, the posture stays and waits before it drives again.
        public void stop() {active=null;if(posture!=null)posture.interrupt();}
        public JsonObject posture(JsonObject p) {
            if(p.has("off")&&bool(p,"off")){clearPosture();return obj();}
            long revision=(long)number(p,"postureRevision");
            Posture next=string(p,"action").equals("wait")?Posture.waiting(revision,view())
                :Posture.follow(new FollowCompanion(string(p,"player"),UUID.fromString(string(p,"expectedEntityId")),2.5,false,terrain,terrain.time::get,new Random(7)),revision,view());
            clearPosture();posture=next;return posture.json();
        }
        public void clearPosture() {Posture old=posture;posture=null;if(old!=null)old.halt();}
        Posture.View view() {
            java.util.function.BooleanSupplier permission=session.dutyPermission();
            return new Posture.View() {
                public long now() {return terrain.time.get();}
                public boolean mayDrive() {return permission.getAsBoolean();}
                public boolean seated() {return seated;}
                public void standUp() {seated=false;standUps=true;}
                public boolean returnToSeat(BlockPos seat) {
                    if(seatFailure!=null)throw error(seatFailure,"Scripted seat failure");
                    if(seatBusy-->0)throw error(busyCode,"Scripted passing refusal");
                    if(seatSteps-->0)return false;
                    seated=true;return true;
                }
                public void stopSeatWalk() {seatWalkStops++;}
            };
        }
        JsonObject set(JsonObject request) {request.addProperty("postureRevision",++revision);return session.call("posture",request);}
        JsonObject follow() {JsonObject r=auth.deepCopy();r.addProperty("action","follow");r.addProperty("player","muxue");r.addProperty("expectedEntityId",FollowCompanionTest.TARGET.toString());return set(r);}
        JsonObject act(String name) {
            JsonObject act=auth.deepCopy();act.addProperty("operationId",UUID.randomUUID().toString());
            act.addProperty("controlGeneration",session.generation());act.addProperty("name",name);act.add("args",obj());return session.call("act",act);
        }
        /** The operation ends normally: as ServerController.finish, a KEEPS or HOLDS action leaves the posture alone; any other ends through stop. */
        void finish() {boolean quiet=posture!=null&&posture.endsQuietly(active.name);active.finish("succeeded","Done",null);if(quiet)active=null;else stop();}
        /** One tick in ServerController.tickPosture order (after the guard); true when the posture drove. */
        boolean tick(long elapsed) {
            terrain.time.addAndGet(elapsed);session.call("heartbeat",auth);
            if(posture==null){terrain.physics();return false;}
            if(fighting){posture.guarding();wasFighting=true;terrain.physics();return false;}
            if(wasFighting){wasFighting=false;posture.resumeAfterGuard();}
            Posture current=posture;
            List<String> running=session.running();
            String yielded=current.yieldTo(running,animating);
            boolean drove=current.tick(yielded,current.holdsFor(running));
            if(current.ended())posture=null;
            terrain.physics();return drove;
        }
        String state() {return posture.json().get("state").getAsString();}
    }
    static void run() {
        Fixture f=new Fixture();
        JsonObject set=f.follow();
        check(set.get("postureRevision").getAsLong()==1&&set.get("action").getAsString().equals("follow")&&set.get("player").getAsString().equals("muxue")&&set.get("entityId").getAsString().equals(FollowCompanionTest.TARGET.toString()),"posture follow through the protocol: revision, player and identity in the reply");
        check(f.tick(50)&&f.state().equals("following")&&f.terrain.input!=null,"a new follow drives at once when nothing runs");
        // An operation takes the body: the posture yields, no walking of its own.
        f.immediate=false;f.act("dig-block");
        int moves=f.terrain.moves;
        check(!f.tick(50)&&f.state().equals("suspended")&&f.posture.json().get("suspendedFor").getAsString().equals("dig-block")&&f.terrain.input==null,"an operation runs: suspended for it, the follow stops walking");
        for(int i=0;i<20;i++)f.tick(50);
        check(f.terrain.moves==moves,"while suspended the posture never walks");
        f.finish();
        check(!f.tick(50)&&f.state().equals("suspended"),"the operation ended: still suspended");
        f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS-200);
        check(!f.tick(50)&&f.state().equals("suspended")&&f.posture.json().get("resumeInMs").getAsLong()>0,"less than RESUME_AFTER_MS since: still suspended, with the time left");
        f.act("dig-block");f.tick(50);f.finish();f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS-200);
        check(!f.tick(50)&&f.state().equals("suspended"),"a new operation in the pause starts the wait again");
        check(f.tick(200)&&f.state().equals("following"),"RESUME_AFTER_MS after the last operation: follows again on its own, same posture");
        check(f.posture.revision==1,"resuming never needs a new request");
        // Actions that do not move the body leave it driving.
        f.act("select-slot");
        check(f.tick(50)&&f.state().equals("following"),"select-slot running: the posture keeps driving");
        f.finish();f.immediate=true;
        // An add-on animation outlives its emote operation: the posture waits for it to end, then the usual pause.
        f.act("emote");f.animating=true;
        check(!f.tick(50)&&f.state().equals("suspended")&&f.posture.json().get("suspendedFor").getAsString().equals("emote"),"emote finished but its animation plays: suspended for emote");
        f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS*2);
        check(!f.tick(50)&&f.state().equals("suspended"),"a long animation is never cut by the pause running out");
        f.animating=false;
        check(!f.tick(50)&&f.state().equals("suspended"),"animation over: still the pause after it");
        f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS);
        check(f.tick(50)&&f.state().equals("following"),"RESUME_AFTER_MS after the animation: follows again");
        // An ordinary stop keeps the posture; clearPosture ends it.
        f.session.call("stop",f.auth);
        check(f.posture!=null&&f.state().equals("suspended"),"an ordinary stop keeps the posture and pauses it");
        f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS);
        check(f.tick(50)&&f.state().equals("following"),"and it follows again afterwards");
        // The guard: guarding while it fights, then the follow plans again.
        f.fighting=true;f.tick(50);
        check(f.state().equals("guarding")&&f.terrain.input==null,"the guard fights: guarding, the follow stands aside");
        int resets=f.terrain.resets;f.fighting=false;
        check(f.tick(50)&&f.state().equals("following")&&f.terrain.resets==resets+1,"fight over: follows again from a fresh route");
        JsonObject clearing=f.auth.deepCopy();clearing.addProperty("clearPosture",true);clearing.addProperty("postureRevision",++f.revision);
        f.session.call("stop",clearing);
        check(f.posture==null&&f.terrain.input==null,"stop with clearPosture ends the posture");
        // Away and back; someone else behind the name ends it.
        f.follow();f.tick(50);f.terrain.online=false;f.tick(50);
        check(f.posture!=null&&f.state().equals("away")&&f.posture.json().get("reason").getAsString().equals("PLAYER_AWAY"),"player offline: away, the posture stays");
        f.terrain.online=true;
        check(f.tick(50)&&f.state().equals("following"),"player back: follows on its own");
        f.terrain.uuid=UUID.fromString("00000000-0000-4000-8000-000000000002");f.tick(50);
        check(f.posture==null,"someone else behind the followed name: the posture ends");
        f.terrain.uuid=FollowCompanionTest.TARGET;
        // Wait: stands where it is; after a fight the guard walks it back.
        JsonObject wait=f.auth.deepCopy();wait.addProperty("action","wait");f.set(wait);
        check(!f.tick(50)&&f.state().equals("waiting")&&f.posture.guardWalksBack()&&f.terrain.input==null,"wait: waiting, never drives, the guard walks back after a fight");
        f.session.call("stop",f.auth);f.tick(50);
        check(f.state().equals("waiting"),"an ordinary stop does not turn a wait into suspended (nothing moved)");
        // The lease ends: nothing drives any more.
        f.follow();f.tick(50);
        f.session.call("release",f.auth);
        check(f.posture==null,"releasing the lease drops the posture");
        seated();
        gestures();
        System.out.println("PostureTest: "+checks+" checks passed");
    }
    /**
     * Step 3 (companion_state_design.md): a built-in gesture makes the posture stand still without a pause tail, look-at keeps
     * driving, an add-on animation and other actions keep the pause as before. Every case goes through session.call and tick.
     */
    private static void gestures() {
        // 1. A gesture while walking: the body stops for it, never reads as suspended, and walks again the tick it ends.
        Fixture walk=new Fixture();walk.follow();
        check(walk.tick(50)&&walk.terrain.input!=null,"walking toward the player before the gesture");
        walk.immediate=false;walk.act("emote");
        int moves=walk.terrain.moves;
        for(int i=0;i<10;i++) check(!walk.tick(50)&&walk.state().equals("following")&&walk.terrain.input==null&&!walk.posture.json().has("suspendedFor")&&!walk.posture.json().has("resumeInMs"),"a gesture playing: the follow stands still, never suspended, no pause");
        check(walk.terrain.moves==moves,"while the gesture plays the follow never walks");
        walk.finish();
        check(walk.tick(50)&&walk.state().equals("following")&&walk.terrain.input!=null,"the gesture ended: walks again on the very next tick, no pause");
        // A guard fight during a gesture: the guard takes the body first; afterwards the gesture still holds, never guarding or suspended.
        Fixture fight=new Fixture();fight.follow();fight.tick(50);
        fight.immediate=false;fight.act("emote");
        fight.fighting=true;
        check(!fight.tick(50)&&fight.state().equals("guarding")&&fight.terrain.input==null,"guard fights during a gesture: guarding, the follow stands aside");
        fight.fighting=false;
        check(!fight.tick(50)&&fight.state().equals("following")&&fight.terrain.input==null,"fight over while the gesture still plays: following, standing still, not guarding");
        fight.finish();
        check(fight.tick(50)&&fight.state().equals("following"),"gesture ended after the fight: follows at once");
        // 2. A gesture while waiting or seated: nothing changes, no state flicker, no pause.
        Fixture waiting=new Fixture();
        JsonObject wait=waiting.auth.deepCopy();wait.addProperty("action","wait");waiting.set(wait);
        check(!waiting.tick(50)&&waiting.state().equals("waiting"),"waiting before the gesture");
        waiting.immediate=false;waiting.act("emote");
        check(!waiting.tick(50)&&waiting.state().equals("waiting")&&!waiting.posture.json().has("resumeInMs"),"waiting while a gesture plays: still waiting, never suspended");
        waiting.finish();
        check(!waiting.tick(50)&&waiting.state().equals("waiting")&&!waiting.posture.json().has("resumeInMs"),"waiting after the gesture: unchanged, nothing pending");
        Fixture seat=new Fixture();BlockPos chair=new BlockPos(3,1,3);
        seat.seated=true;seat.posture=Posture.seated(chair,0,seat.view());
        seat.immediate=false;seat.act("emote");
        check(!seat.tick(50)&&seat.state().equals("seated")&&seat.seated&&!seat.standUps,"seated while a gesture plays: still seated, no stand-up");
        seat.finish();
        check(!seat.tick(50)&&seat.state().equals("seated")&&seat.seated&&!seat.standUps,"seated after the gesture: still seated");
        // 3. An add-on animation: unchanged; it outlives its operation, and the posture waits for it and then the usual pause.
        Fixture addon=new Fixture();addon.follow();addon.tick(50);
        addon.act("emote");addon.animating=true;
        check(!addon.tick(50)&&addon.state().equals("suspended")&&addon.posture.json().get("suspendedFor").getAsString().equals("emote"),"add-on animation playing: suspended for emote");
        addon.animating=false;
        check(!addon.tick(50)&&addon.state().equals("suspended")&&addon.posture.json().get("resumeInMs").getAsLong()>0,"animation over: the 3-second pause runs");
        addon.terrain.time.addAndGet(Posture.RESUME_AFTER_MS);
        check(addon.tick(50)&&addon.state().equals("following"),"RESUME_AFTER_MS after the animation: follows again");
        // 4. look-at keeps driving, whether it is still running or already finished (the server finishes it at once).
        Fixture look=new Fixture();look.follow();look.tick(50);
        look.immediate=false;look.act("look-at");
        check(look.tick(50)&&look.state().equals("following")&&look.terrain.input!=null&&!look.posture.json().has("suspendedFor"),"look-at running: the follow keeps walking, never suspended");
        look.finish();
        check(look.tick(50)&&look.state().equals("following"),"look-at ended: the follow keeps driving with no pause");
        look.immediate=true;look.act("look-at");
        check(look.tick(50)&&look.state().equals("following"),"look-at finished at once: the follow keeps driving");
        // 5. Another real action, or an explicit stop during a gesture: the pause as before.
        Fixture move=new Fixture();move.follow();move.tick(50);
        move.immediate=false;move.act("move-to-position");
        check(!move.tick(50)&&move.state().equals("suspended")&&move.posture.json().get("suspendedFor").getAsString().equals("move-to-position"),"move-to-position: suspended for it, as before");
        move.finish();
        move.terrain.time.addAndGet(Posture.RESUME_AFTER_MS-200);
        check(!move.tick(50)&&move.state().equals("suspended"),"move-to-position ended: still in the 3-second pause");
        move.terrain.time.addAndGet(200);
        check(move.tick(50)&&move.state().equals("following"),"then follows again once the pause is over");
        Fixture halted=new Fixture();halted.follow();halted.tick(50);
        halted.immediate=false;halted.act("emote");
        halted.session.call("stop",halted.auth);
        check(!halted.tick(50)&&halted.state().equals("suspended")&&halted.posture.json().get("resumeInMs").getAsLong()>0,"an explicit stop during a gesture: the 3-second pause applies as before");
    }
    /** Sitting as a posture: what a seated body may do does not suspend it; after a fight it walks back and sits. */
    private static void seated() {
        Fixture f=new Fixture();BlockPos chair=new BlockPos(3,1,3);
        f.seated=true;f.posture=Posture.seated(chair,0,f.view());
        check(!f.tick(50)&&f.state().equals("seated")&&!f.posture.guardWalksBack(),"seated: sitting, nothing to drive, the posture takes the body back after a fight");
        check(f.posture.json().getAsJsonObject("seat").get("x").getAsInt()==3,"the seat is in the posture");
        f.immediate=false;f.act("eat-item");
        check(f.state().equals("seated")&&!f.tick(50)&&f.state().equals("seated"),"eating while seated does not suspend the seated posture");
        f.finish();f.immediate=true;f.terrain.time.addAndGet(Posture.RESUME_AFTER_MS);
        // The guard stood it up for a fight; afterwards it walks back and sits.
        f.seated=false;f.fighting=true;f.tick(50);
        check(f.state().equals("guarding"),"fighting: guarding");
        f.fighting=false;f.seatSteps=3;
        check(f.tick(50)&&f.posture.json().get("returning").getAsBoolean(),"fight over: walking back to the seat");
        for(int i=0;i<3;i++)f.tick(50);
        check(f.seated&&f.state().equals("seated")&&!f.posture.json().has("returning"),"back on the seat");
        // A seat taken meanwhile: the posture turns into waiting and says why.
        f.seated=false;f.seatFailure="SEAT_OCCUPIED";f.tick(50);
        check(f.posture.kind()==Posture.Kind.WAIT&&f.state().equals("waiting")&&f.posture.json().get("reason").getAsString().equals("SEAT_OCCUPIED")&&!f.posture.json().has("seat"),"seat taken: waiting, reason SEAT_OCCUPIED");
        Fixture gone=new Fixture();gone.posture=Posture.seated(chair,0,gone.view());gone.seatFailure="STALE_TARGET";gone.tick(50);
        check(gone.posture.json().get("reason").getAsString().equals("NO_SEAT"),"the block is no longer a seat: reason NO_SEAT");
        Fixture far=new Fixture();far.posture=Posture.seated(chair,0,far.view());far.seatSteps=Integer.MAX_VALUE;far.tick(50);
        for(long waited=0;waited<=GuardDuty.BACK_LIMIT_MS&&far.posture.kind()==Posture.Kind.SEATED;waited+=1000)far.tick(1000); // heartbeats keep the lease
        check(far.posture.kind()==Posture.Kind.WAIT&&far.posture.json().get("reason").getAsString().equals("NO_PATH"),"not back on the seat within the guard's walk-back limit: waiting, NO_PATH");
        passing();
        // Following from a seat stands up first.
        Fixture up=new Fixture();up.seated=true;up.follow();up.tick(50);
        check(up.standUps&&!up.seated&&up.state().equals("following"),"follow while sitting: stands up and follows");
    }
    /**
     * The way back to the seat refuses for a reason that passes (an open menu: BUSY from NativeSeat.requireCanSit): the posture stays
     * seated-and-returning and tries again next tick, under the same BACK_LIMIT_MS clock; every other code still means waiting.
     */
    private static void passing() {
        BlockPos chair=new BlockPos(3,1,3);
        Fixture busy=new Fixture();busy.posture=Posture.seated(chair,0,busy.view());busy.seatBusy=4;busy.seatSteps=1;
        int stops=busy.seatWalkStops;
        for(int i=0;i<4;i++) {
            check(!busy.tick(50),"BUSY: the body stands still, nothing is driven");
            check(busy.posture.kind()==Posture.Kind.SEATED&&busy.state().equals("seated")&&!busy.posture.json().has("reason")&&busy.posture.json().get("returning").getAsBoolean(),"BUSY: still the seated posture, no reason, still returning");
        }
        check(busy.seatWalkStops==stops+4,"each refusal stops the walk so the body does not keep walking blind");
        check(busy.tick(50)&&busy.posture.kind()==Posture.Kind.SEATED,"the menu closed: the walk goes on (one more step)");
        busy.tick(50);
        check(busy.seated&&busy.posture.kind()==Posture.Kind.SEATED&&busy.state().equals("seated")&&!busy.posture.json().has("returning"),"and it sits back down");
        // SLEEPING passes as well.
        Fixture asleep=new Fixture();asleep.posture=Posture.seated(chair,0,asleep.view());asleep.seatBusy=2;asleep.busyCode="SLEEPING";
        asleep.tick(50);asleep.tick(50);
        check(asleep.posture.kind()==Posture.Kind.SEATED&&!asleep.posture.json().has("reason"),"SLEEPING: tried again, not given up");
        asleep.tick(50);
        check(asleep.seated,"asleep no more: back on the seat");
        // A refusal that never passes ends at the guard's walk-back limit, as a walk that never arrives does.
        Fixture stuck=new Fixture();stuck.posture=Posture.seated(chair,0,stuck.view());stuck.seatBusy=Integer.MAX_VALUE;stuck.tick(50);
        for(long waited=0;waited<=GuardDuty.BACK_LIMIT_MS&&stuck.posture.kind()==Posture.Kind.SEATED;waited+=1000) {
            stuck.tick(1000);
            if(waited<GuardDuty.BACK_LIMIT_MS-1000)check(stuck.posture.kind()==Posture.Kind.SEATED,"BUSY inside the time limit: still trying");
        }
        check(stuck.posture.kind()==Posture.Kind.WAIT&&stuck.posture.json().get("reason").getAsString().equals("NO_PATH"),"BUSY for longer than the limit: waiting, NO_PATH");
        // The permanent codes still end it at once (SEAT_OCCUPIED and STALE_TARGET are checked above); the same for the ones from the walk and the click.
        for(String code:new String[]{"NO_SEAT","NO_PATH","BLOCKED","OUT_OF_REACH","NO_LINE_OF_SIGHT","EMPTY_HAND_REQUIRED","SIT_REFUSED","WRONG_SEAT","UNKNOWN"}) {
            Fixture gone=new Fixture();gone.posture=Posture.seated(chair,0,gone.view());gone.seatFailure=code;gone.tick(50);
            check(gone.posture.kind()==Posture.Kind.WAIT&&gone.posture.json().get("reason").getAsString().equals(code),code+": the seat or the way is gone: waiting with that reason");
        }
        check(!Posture.RETRY_CODES.contains("SEAT_OCCUPIED")&&!Posture.RETRY_CODES.contains("STALE_TARGET")&&Posture.RETRY_CODES.equals(Set.of("BUSY","SLEEPING")),"only BUSY and SLEEPING are passing refusals");
    }}
