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
        int seatSteps,seatWalkStops;
        String seatFailure;
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
        void finish() {active.finish("succeeded","Done",null);stop();}
        /** One tick in ServerController.beforePhysics order; true when the posture drove. */
        boolean tick(long elapsed) {
            terrain.time.addAndGet(elapsed);session.call("heartbeat",auth);
            if(posture==null){terrain.physics();return false;}
            if(fighting){posture.guarding();wasFighting=true;terrain.physics();return false;}
            if(wasFighting){wasFighting=false;posture.resumeAfterGuard();}
            Posture current=posture;
            String running=current.yieldTo(session.running(),animating);
            boolean drove=current.tick(running);
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
        System.out.println("PostureTest: "+checks+" checks passed");
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
        // Following from a seat stands up first.
        Fixture up=new Fixture();up.seated=true;up.follow();up.tick(50);
        check(up.standUps&&!up.seated&&up.state().equals("following"),"follow while sitting: stands up and follows");
    }
}
