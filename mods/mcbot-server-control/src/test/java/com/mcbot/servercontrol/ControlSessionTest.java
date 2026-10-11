package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static com.mcbot.servercontrol.Protocol.*;

/** Plain JVM regression against control boundary behavior, no Minecraft launch. */
public final class ControlSessionTest {
    private static int checks;
    private static final class FakeGame implements ControlSession.Game {
        boolean exists,dead,savedDead;
        int creations,starts,stops,respawns;
        boolean immediate=true,postureCap;
        boolean crashChat,crashStop,nearby,guardDuty,interrupts,window;
        ControlSession.Operation paused;
        JsonObject guarding,posturing;int dutyClears,postureClears;
        int discoveries;
        final List<String> notices=new ArrayList<>();
        ControlSession.Operation active;
        @Override public boolean connected() { return exists&&!dead; }
        @Override public void ensureBody() { if(dead)throw error("DEAD_BODY","Explicit respawn required");if(!exists) {exists=true;creations++;} }
        @Override public void respawn() {
            if((!exists||!dead)&&!savedDead)throw error("INVALID_ARGUMENT","No dead body");
            exists=true;dead=false;savedDead=false;respawns++;
        }
        @Override public boolean leave() { if(!exists)return false;exists=false;dead=false;return true; }
        @Override public JsonObject hello() { List<String> caps=new ArrayList<>(List.of("send-chat"));if(nearby)caps.add("nearby-blocks");if(guardDuty)caps.add("guard-duty-fenced");if(postureCap)caps.add("server-posture");if(interrupts)caps.add("task-interrupts");return obj("capabilities",caps); }
        @Override public JsonObject interrupt(JsonObject p) {
            if(string(p,"action").equals("begin")){window=true;paused=active;active=null;return obj("open",true);}
            window=false;active=paused;paused=null;return obj("open",false);
        }
        @Override public boolean interruptOpen() { return window; }
        @Override public ControlSession.Operation interruptPaused() { return paused; }
        @Override public JsonObject guard(JsonObject p) { guarding=p.has("off")?null:p;return obj("enabled",guarding!=null); }
        @Override public void clearDuty() { dutyClears++;guarding=null; }
        @Override public JsonObject posture(JsonObject p) { posturing=p.has("off")?null:p;return obj("state","following"); }
        @Override public void clearPosture() { postureClears++;posturing=null; }
        @Override public JsonObject observe(JsonObject p) { return obj("source","server-observed","container",null); }
        @Override public JsonObject nearbyBlocks(JsonObject p) {discoveries++;return obj("dimension","minecraft:overworld","candidates",List.of());}
        @Override public JsonObject watch() { return obj("chat",List.of(),"chatCursor",7); }
        @Override public long chatCursor() { return 7; }
        @Override public void notice(String text) { notices.add(text); }
        @Override public void begin(ControlSession.Operation o) {
            starts++;
            if(crashChat&&o.name.equals("send-chat"))throw new IllegalStateException();
            if(immediate)o.finish("succeeded","Done",null);else active=o;
        }
        @Override public void abort(ControlSession.Operation o) {if(active==o)stop();}
        @Override public void stop() {stops++;if(crashStop)throw new IllegalStateException("Injected native cleanup failure");active=null;window=false;paused=null;}
    }
    private static final class Fixture {
        final FakeGame game=new FakeGame();
        final AtomicLong time=new AtomicLong();
        final ControlSession session=new ControlSession(game,time::get,"world","ServerBot");
        JsonObject claim(String controller) { return session.call("claim",obj("instanceId",session.instanceId,"worldId","world","username","ServerBot","controllerId",controller)); }
        JsonObject act(JsonObject claim,String id,String name) {JsonObject p=act(claim,id);p.addProperty("name",name);return p;}
        JsonObject auth(JsonObject claim) {return obj("instanceId",session.instanceId,"sessionId",claim.get("sessionId").getAsString(),"leaseId",claim.get("leaseId").getAsString());}
        JsonObject host(JsonObject claim) {JsonObject p=auth(claim);p.add("stopToken",claim.get("stopToken"));return p;}
        JsonObject act(JsonObject claim,String id) {
            JsonObject p=auth(claim);p.add("controlGeneration",claim.get("controlGeneration"));p.addProperty("operationId",id);p.addProperty("name","send-chat");p.add("args",obj("message","hello"));return p;
        }
    }
    private static void check(boolean condition,String message) {checks++;if(!condition)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable runnable) {
        checks++;
        try {runnable.run();throw new AssertionError("Expected "+code);}
        catch(Protocol.Error e) {if(!e.code.equals(code))throw new AssertionError("Expected "+code+", got "+e.code);}
    }
    private static void budget(JsonObject response,int used,String message) {
        check(response.getAsJsonObject("operationBudget").equals(obj("used",used,"remaining",ControlSession.ID_LIMIT-used,"limit",ControlSession.ID_LIMIT,"exhausted",used==ControlSession.ID_LIMIT)),message);
    }
    /** The posture: a lease-bound method like the guard, ordered by postureRevision; a stop keeps it, clearPosture or the end of the lease drops it. */
    private static void posture() {
        Fixture f=new Fixture();JsonObject claim=f.claim("a");int base=f.game.postureClears;
        JsonObject follow=f.auth(claim);follow.addProperty("postureRevision",1);follow.addProperty("action","follow");
        errorCode("UNSUPPORTED",()->f.session.call("posture",follow));
        f.game.postureCap=true;
        JsonObject set=f.session.call("posture",follow);
        check(set.get("postureRevision").getAsLong()==1&&f.game.posturing!=null&&f.game.starts==0,"posture is set by its own method, not an operation");
        budget(set,0,"posture uses no operation ID");
        errorCode("CANCELLED",()->f.session.call("posture",follow));
        JsonObject zero=f.auth(claim);zero.addProperty("postureRevision",0);zero.addProperty("action","wait");
        errorCode("INVALID_ARGUMENT",()->f.session.call("posture",zero));
        f.session.call("stop",f.auth(claim));
        check(f.game.posturing!=null&&f.game.postureClears==base,"an ordinary stop keeps the posture");
        JsonObject clearing=f.auth(claim);clearing.addProperty("clearPosture",true);clearing.addProperty("postureRevision",2);
        long before=f.session.generation();f.session.call("stop",clearing);
        check(f.game.posturing==null&&f.game.postureClears==base+1&&f.session.generation()==before+1,"a stop with clearPosture stops and clears in one request");
        JsonObject newer=f.auth(claim);newer.addProperty("postureRevision",4);newer.addProperty("action","wait");f.session.call("posture",newer);
        JsonObject late=f.auth(claim);late.addProperty("clearPosture",true);late.addProperty("postureRevision",3);
        before=f.session.generation();f.session.call("stop",late);
        check(f.game.posturing!=null&&f.session.generation()==before+1,"a late clearing stop still stops but keeps the newer posture");
        JsonObject both=f.auth(claim);both.addProperty("clearPosture",true);both.addProperty("postureRevision",5);both.addProperty("clearGuard",true);both.addProperty("guardRevision",1);
        f.session.call("stop",both);
        check(f.game.posturing==null&&f.game.dutyClears>=1,"stop-action clears guard and posture together");
        // Nothing runs beside an operation any more: the follow is no operation, so select-slot is BUSY only behind a real one.
        f.game.immediate=false;JsonObject now=f.claim("a");
        JsonObject move=f.act(now,UUID.randomUUID().toString(),"move-to-position");move.add("controlGeneration",JSON.toJsonTree(f.session.generation()));
        f.session.call("act",move);f.game.immediate=true;
        JsonObject select=f.act(now,UUID.randomUUID().toString(),"select-slot");select.add("controlGeneration",JSON.toJsonTree(f.session.generation()));
        errorCode("BUSY",()->f.session.call("act",select));
        JsonObject held=f.auth(now);held.addProperty("postureRevision",6);held.addProperty("action","wait");f.session.call("posture",held);
        int clears=f.game.postureClears;f.session.call("release",f.auth(now));
        check(f.game.posturing==null&&f.game.postureClears>clears,"releasing the lease drops the posture");
        JsonObject again=f.claim("b");
        JsonObject fresh=f.auth(again);fresh.addProperty("postureRevision",1);fresh.addProperty("action","wait");
        check(f.session.call("posture",fresh).get("postureRevision").getAsLong()==1,"a new lease counts posture revisions from zero again");
    }
    /** The interrupt window (8.4): fenced by the generation, no operation ID; beside the paused operation only eating and defense steps start, one at a time. */
    private static void interrupts() {
        Fixture f=new Fixture();JsonObject claim=f.claim("a");f.game.immediate=false;
        JsonObject move=f.act(claim,UUID.randomUUID().toString(),"move-to-position");
        f.session.call("act",move);ControlSession.Operation walking=f.game.active;
        JsonObject begin=f.auth(claim);begin.add("controlGeneration",claim.get("controlGeneration"));begin.addProperty("action","begin");begin.addProperty("reason","eat");
        errorCode("UNSUPPORTED",()->f.session.call("interrupt",begin));
        f.game.interrupts=true;
        JsonObject stale=begin.deepCopy();stale.addProperty("controlGeneration",f.session.generation()+1);
        errorCode("STALE_CONTROL",()->f.session.call("interrupt",stale));
        budget(f.session.call("interrupt",begin),1,"opening a window uses no operation ID");
        check(f.game.paused==walking&&walking.status.equals("running"),"the paused operation keeps running");
        errorCode("BUSY",()->f.session.call("act",f.act(claim,UUID.randomUUID().toString(),"dig-block")));
        JsonObject select=f.act(claim,UUID.randomUUID().toString(),"select-slot");
        check(f.session.call("act",select).get("status").getAsString().equals("running"),"an eating step starts beside the paused operation");
        errorCode("BUSY",()->f.session.call("act",f.act(claim,UUID.randomUUID().toString(),"eat-item")));
        check(f.session.call("act",f.act(claim,UUID.randomUUID().toString())).get("status").getAsString().equals("running"),"chat still goes out inside a window");
        check(f.session.stepsRunning(walking)&&f.session.cancelSteps(walking,"closed"),"a step left running is found and cancelled");
        check(!f.session.stepsRunning(walking)&&walking.status.equals("running")&&f.session.running().contains("move-to-position"),"cancelling steps leaves the paused operation running");
        JsonObject end=f.auth(claim);end.add("controlGeneration",claim.get("controlGeneration"));end.addProperty("action","end");
        f.session.call("interrupt",end);
        errorCode("BUSY",()->f.session.call("act",f.act(claim,UUID.randomUUID().toString(),"select-slot")));
        f.session.call("interrupt",begin);
        long before=f.session.generation();f.session.call("stop",f.auth(claim));
        check(!f.game.window&&walking.status.equals("cancelled")&&f.session.generation()==before+1,"a stop ends the window and the paused operation with it");
        errorCode("STALE_CONTROL",()->f.session.call("interrupt",begin));
    }
    public static void main(String[] ignored) throws Exception {
        Fixture f=new Fixture();
        JsonObject hello=f.session.call("hello",obj());
        check(!hello.get("connected").getAsBoolean()&&hello.get("sessionId").isJsonNull(),"hello does not create body");
        check(f.game.creations==0&&hello.get("username").getAsString().equals("ServerBot"),"configured identity before claim");
        JsonObject claim=f.claim("a"), auth=f.auth(claim);
        check(f.game.creations==1&&claim.get("chatCursor").getAsLong()==7,"claim creates one body and cursor");
        budget(claim,0,"new lease exposes its full lifetime operation budget");
        errorCode("UNSUPPORTED",()->f.session.call("nearby-blocks",auth));
        f.game.nearby=true;
        JsonObject nearby=f.session.call("nearby-blocks",auth);
        check(nearby.get("instanceId").getAsString().equals(f.session.instanceId)&&nearby.get("sessionId").equals(claim.get("sessionId"))&&nearby.get("worldId").getAsString().equals("world")&&nearby.get("controlGeneration").equals(claim.get("controlGeneration")),"nearby discovery binds full control context");
        check(f.game.discoveries==1&&f.game.starts==0,"discovery is a read and creates no operation");
        budget(nearby,0,"nearby reads do not consume operation IDs");
        JsonObject wrongNearby=auth.deepCopy();wrongNearby.addProperty("leaseId","wrong");
        errorCode("LEASE_LOST",()->f.session.call("nearby-blocks",wrongNearby));
        check(f.game.discoveries==1,"unauthorized discovery never enters game code");
        errorCode("LEASE_BUSY",()->f.claim("b"));
        check(f.claim("a").get("leaseId").equals(claim.get("leaseId")),"same controller retry is idempotent");
        String id=UUID.randomUUID().toString();JsonObject action=f.act(claim,id);
        JsonObject first=f.session.call("act",action),again=f.session.call("act",action.deepCopy());
        check(first.equals(again)&&f.game.starts==1,"duplicate ID does not repeat action");
        budget(first,1,"first admitted ID consumes exactly one unit");
        budget(again,1,"duplicate ID consumes no additional units");
        JsonObject changed=action.deepCopy();changed.add("args",obj("message","different"));
        errorCode("OPERATION_CONFLICT",()->f.session.call("act",changed));
        JsonObject observation=f.session.call("observe",auth);
        check(observation.get("container").isJsonNull()&&observation.get("instanceId").getAsString().equals(f.session.instanceId),"observation carries epoch and null");
        budget(observation,1,"observation does not consume the lifetime budget");
        JsonObject wrong=auth.deepCopy();wrong.addProperty("instanceId","other");errorCode("WRONG_INSTANCE",()->f.session.call("heartbeat",wrong));
        JsonObject stopped=f.session.call("stop",auth);
        check(stopped.get("controlGeneration").getAsLong()>claim.get("controlGeneration").getAsLong()&&f.game.exists,"stop advances generation and retains body");
        budget(stopped,1,"stop changes generation without resetting the lease operation budget");
        errorCode("STALE_CONTROL",()->f.session.call("act",f.act(claim,UUID.randomUUID().toString())));
        JsonObject fresh=f.act(claim,UUID.randomUUID().toString());fresh.add("controlGeneration",stopped.get("controlGeneration"));
        check(f.session.call("act",fresh).get("status").getAsString().equals("succeeded"),"first new-generation action works");
        f.session.call("revoke",f.host(claim));check(f.game.exists,"host revoke retains body");
        errorCode("LEASE_LOST",()->f.session.call("heartbeat",auth));
        check(f.session.call("watch",f.host(claim)).get("chatCursor").getAsLong()==7,"retired host can watch without lease");
        JsonObject next=f.claim("b");check(f.game.creations==1,"reclaim attaches retained body");
        int stops=f.game.stops;f.session.call("revoke",f.host(claim));
        check(f.game.stops==stops,"old host revoke never stops new lease");
        errorCode("LEASE_LOST",()->f.session.call("watch",f.host(claim)));
        f.session.call("heartbeat",f.auth(next));
        Fixture notices=new Fixture();JsonObject noticeClaim=notices.claim("a");
        JsonObject note=notices.host(noticeClaim);note.addProperty("text","started");
        check(notices.session.call("notice",note).get("shown").getAsBoolean()&&notices.game.notices.equals(List.of("started")),"leased notice reaches the game");
        JsonObject second=note.deepCopy();second.addProperty("text","second");
        errorCode("RATE_LIMITED",()->notices.session.call("notice",second));
        notices.time.set(1999);errorCode("RATE_LIMITED",()->notices.session.call("notice",second));
        notices.time.set(2000);check(notices.session.call("notice",second).get("shown").getAsBoolean()&&notices.game.notices.size()==2,"notice passes once two seconds have elapsed");
        notices.session.call("revoke",notices.host(noticeClaim));
        JsonObject retiredNote=notices.host(noticeClaim);retiredNote.addProperty("text","stopped");notices.time.set(4000);
        check(notices.session.call("notice",retiredNote).get("shown").getAsBoolean()&&notices.game.notices.size()==3,"retired lease can notice without a live lease");
        JsonObject retiredWrong=retiredNote.deepCopy();retiredWrong.addProperty("stopToken","wrong");
        errorCode("LEASE_LOST",()->notices.session.call("notice",retiredWrong));
        JsonObject nextClaim=notices.claim("b");
        JsonObject badToken=notices.host(nextClaim);badToken.addProperty("text","bad");badToken.addProperty("stopToken","wrong");
        errorCode("FORBIDDEN",()->notices.session.call("notice",badToken));
        JsonObject tooLong=notices.host(nextClaim);tooLong.addProperty("text","x".repeat(121));
        errorCode("INVALID_ARGUMENT",()->notices.session.call("notice",tooLong));
        JsonObject controlled=notices.host(nextClaim);controlled.addProperty("text","a§b");
        errorCode("INVALID_ARGUMENT",()->notices.session.call("notice",controlled));
        check(notices.game.notices.size()==3,"rejected notices never reach the game");
        Fixture leaving=new Fixture();JsonObject leavingClaim=leaving.claim("a");
        JsonObject shutdown=leaving.host(leavingClaim);shutdown.addProperty("leave",true);
        check(leaving.session.call("revoke",shutdown).get("left").getAsBoolean()&&!leaving.game.exists,"host shutdown revoke logs the body out");
        check(!leaving.session.call("revoke",shutdown).get("left").getAsBoolean(),"repeated shutdown finds no body to log out");
        JsonObject back=leaving.claim("b");
        check(leaving.game.creations==2&&!back.get("sessionId").equals(leavingClaim.get("sessionId")),"next claim brings the body back in a new session");
        check(!leaving.session.call("revoke",shutdown).get("left").getAsBoolean()&&leaving.game.exists,"old host shutdown never logs out another controller's body");
        Fixture stoppedFirst=new Fixture();JsonObject chatStopped=stoppedFirst.claim("a");
        stoppedFirst.session.call("revoke",stoppedFirst.host(chatStopped));
        JsonObject later=stoppedFirst.host(chatStopped);later.addProperty("leave",true);
        check(stoppedFirst.session.call("revoke",later).get("left").getAsBoolean()&&!stoppedFirst.game.exists,"a host already stopped by chat still logs its body out on shutdown");
        Fixture relay=new Fixture();JsonObject hostA=relay.claim("a");
        relay.session.call("revoke",relay.host(hostA));
        JsonObject hostB=relay.claim("b");relay.session.call("revoke",relay.host(hostB));
        JsonObject lateA=relay.host(hostA);lateA.addProperty("leave",true);
        JsonObject replyA=relay.session.call("revoke",lateA);
        check(replyA.get("stopped").getAsBoolean()&&replyA.get("revoked").getAsBoolean()&&!replyA.get("left").getAsBoolean()&&relay.game.exists,"an earlier host's late leave gets its receipt but never logs out the body a later host drove");
        JsonObject lateB=relay.host(hostB);lateB.addProperty("leave",true);
        check(relay.session.call("revoke",lateB).get("left").getAsBoolean()&&!relay.game.exists,"the most recent host's late leave still logs the body out");
        Fixture lapsed=new Fixture();JsonObject lapseA=lapsed.claim("a");lapsed.session.call("revoke",lapsed.host(lapseA));
        JsonObject lapseB=lapsed.claim("b");lapsed.time.set(20000);
        JsonObject lateLapseA=lapsed.host(lapseA);lateLapseA.addProperty("leave",true);
        check(!lapsed.session.call("revoke",lateLapseA).get("left").getAsBoolean()&&lapsed.game.exists,"a lapsed later lease still shields the body from the earlier host's leave");
        Fixture expiry=new Fixture();JsonObject expiring=expiry.claim("a");expiry.time.set(9000);
        check(expiry.claim("a").get("ttlMs").getAsLong()==1000,"retransmitted claim exposes remaining TTL");expiry.time.set(10000);
        errorCode("LEASE_LOST",()->expiry.session.call("heartbeat",expiry.auth(expiring)));
        check(expiry.game.exists,"expiry does not remove body");
        Fixture physics=new Fixture();physics.game.immediate=false;JsonObject runningClaim=physics.claim("a");
        physics.session.call("act",physics.act(runningClaim,UUID.randomUUID().toString()));
        ControlSession.Operation probe=new ControlSession.Operation("probe",runningClaim.get("sessionId").getAsString(),runningClaim.get("controlGeneration").getAsLong(),"move-to-position",obj());
        check(physics.session.mayDrive(probe),"valid lease before physical tick");physics.time.set(10000);
        check(!physics.session.mayDrive(probe)&&physics.game.stops>0,"expired lease rejected before physical tick");
        Fixture epoch=new Fixture();JsonObject old=epoch.claim("a");epoch.session.bodyChanged();
        errorCode("WORLD_CHANGED",()->epoch.session.call("observe",epoch.auth(old)));
        errorCode("LEASE_LOST",()->epoch.session.call("watch",epoch.host(old)));
        Fixture cache=new Fixture();JsonObject c=cache.claim("a");String firstId=UUID.randomUUID().toString();cache.session.call("act",cache.act(c,firstId));
        for(int i=0;i<ControlSession.HISTORY_LIMIT;i++) cache.session.call("act",cache.act(c,UUID.randomUUID().toString()));
        int starts=cache.game.starts;errorCode("UNKNOWN_OPERATION",()->cache.session.call("act",cache.act(c,firstId)));
        check(cache.game.starts==starts,"evicted ID is never replayed");
        budget(cache.session.call("observe",cache.auth(c)),ControlSession.HISTORY_LIMIT+1,"history eviction never replenishes admitted-ID budget");
        for(int i=ControlSession.HISTORY_LIMIT+1;i<ControlSession.ID_LIMIT-1;i++) cache.session.call("act",cache.act(c,UUID.randomUUID().toString()));
        budget(cache.session.call("observe",cache.auth(c)),ControlSession.ID_LIMIT-1,"4095 accepted IDs leave exactly one unit");
        cache.game.immediate=false;
        JsonObject finalAction=cache.act(c,UUID.randomUUID().toString());finalAction.addProperty("name","move-to-position");
        JsonObject last=cache.session.call("act",finalAction);
        budget(last,ControlSession.ID_LIMIT,"4096th action is admitted and exhausts the lease budget");
        int fullStarts=cache.game.starts;
        check(cache.session.call("act",finalAction.deepCopy()).equals(last)&&cache.game.starts==fullStarts,"last retained ID can be retried while exhausted without execution or new budget use");
        JsonObject conflict=finalAction.deepCopy();conflict.add("args",obj("message","different"));
        errorCode("OPERATION_CONFLICT",()->cache.session.call("act",conflict));
        errorCode("UNKNOWN_OPERATION",()->cache.session.call("act",cache.act(c,firstId)));
        errorCode("OPERATION_LIMIT",()->cache.session.call("act",cache.act(c,UUID.randomUUID().toString())));
        check(cache.game.starts==fullStarts,"conflict, evicted retry and exhausted admission never enter native actions");
        JsonObject lastQuery=cache.auth(c);lastQuery.add("operationId",last.get("operationId"));
        budget(cache.session.call("operation",lastQuery),ControlSession.ID_LIMIT,"operation diagnostics remain available while exhausted");
        budget(cache.session.call("observe",cache.auth(c)),ControlSession.ID_LIMIT,"exhausted observation remains available without consuming or resetting IDs");
        budget(cache.session.call("heartbeat",cache.auth(c)),ControlSession.ID_LIMIT,"heartbeat renewal does not reset exhausted budget");
        budget(cache.claim("a"),ControlSession.ID_LIMIT,"retransmitted claim never rotates exhausted lease");
        JsonObject fullStop=cache.session.call("stop",cache.auth(c));
        budget(fullStop,ControlSession.ID_LIMIT,"stop remains available at exhaustion and does not reset the budget");
        check(cache.game.active==null&&cache.session.call("operation",lastQuery).get("status").getAsString().equals("cancelled"),"stop cancels running native action at the operation-ID limit");
        JsonObject afterStop=cache.act(c,UUID.randomUUID().toString());afterStop.add("controlGeneration",fullStop.get("controlGeneration"));
        errorCode("OPERATION_LIMIT",()->cache.session.call("act",afterStop));
        cache.session.call("release",cache.auth(c));JsonObject reset=cache.claim("b");
        budget(reset,0,"only release and explicit claim establish a fresh operation budget");
        errorCode("LEASE_LOST",()->cache.session.call("observe",cache.auth(c)));
        errorCode("LEASE_LOST",()->cache.session.call("act",cache.act(c,UUID.randomUUID().toString())));
        budget(cache.session.call("observe",cache.auth(reset)),0,"old lease diagnostic and action attempts cannot affect new lease budget");
        cache.session.call("act",cache.act(reset,UUID.randomUUID().toString()));
        check(cache.game.starts==ControlSession.ID_LIMIT+1,"new lease resets bounded ID budget");
        Fixture concurrent=new Fixture();concurrent.game.immediate=false;JsonObject cc=concurrent.claim("a");
        JsonObject movement=concurrent.act(cc,UUID.randomUUID().toString());movement.addProperty("name","move-to-position");
        concurrent.session.call("act",movement);ControlSession.Operation existing=concurrent.game.active;
        concurrent.game.crashChat=true;JsonObject failure=concurrent.session.call("act",concurrent.act(cc,UUID.randomUUID().toString()));
        check(failure.get("status").getAsString().equals("failed")&&failure.getAsJsonObject("result").get("code").getAsString().equals("INTERNAL"),"unexpected action failure carries structured code");
        check(concurrent.game.active==existing&&existing.status.equals("running"),"failing concurrent chat does not abort valid movement");
        Fixture death=new Fixture();JsonObject deathClaim=death.claim("a");
        JsonObject liveRespawn=obj("instanceId",death.session.instanceId,"worldId","world","username","ServerBot","sessionId",death.session.sessionId());
        errorCode("INVALID_ARGUMENT",()->death.session.call("respawn",liveRespawn));
        death.session.call("heartbeat",death.auth(deathClaim));
        check(death.game.respawns==0,"live respawn rejection preserves current lease");
        death.game.dead=true;death.session.bodyChanged();
        errorCode("DEAD_BODY",()->death.claim("a"));
        JsonObject request=obj("instanceId",death.session.instanceId,"worldId","world","username","ServerBot","sessionId",death.session.sessionId());
        JsonObject stale=request.deepCopy();stale.add("sessionId",deathClaim.get("sessionId"));
        errorCode("WORLD_CHANGED",()->death.session.call("respawn",stale));
        JsonObject wrongPlayer=request.deepCopy();wrongPlayer.addProperty("username","OtherBot");
        errorCode("WRONG_PLAYER",()->death.session.call("respawn",wrongPlayer));
        JsonObject wrongWorld=request.deepCopy();wrongWorld.addProperty("worldId","other-world");
        errorCode("WRONG_WORLD",()->death.session.call("respawn",wrongWorld));
        JsonObject missingSession=request.deepCopy();missingSession.remove("sessionId");
        errorCode("INVALID_ARGUMENT",()->death.session.call("respawn",missingSession));
        check(death.game.respawns==0,"respawn preconditions never mutate body");
        JsonObject reborn=death.session.call("respawn",request);
        check(reborn.get("respawned").getAsBoolean()&&reborn.get("connected").getAsBoolean()&&death.game.respawns==1,"explicit death respawn succeeds once");
        check(!reborn.get("sessionId").equals(request.get("sessionId"))&&!reborn.has("leaseId"),"respawn creates new epoch but grants no lease");
        errorCode("WORLD_CHANGED",()->death.session.call("observe",death.auth(deathClaim)));
        errorCode("WORLD_CHANGED",()->death.session.call("respawn",request));
        JsonObject rebound=death.claim("b");
        check(death.game.creations==1&&death.game.respawns==1,"explicit new claim attaches respawned body without duplication");
        death.session.call("heartbeat",death.auth(rebound));
        Fixture savedDeath=new Fixture();savedDeath.game.savedDead=true;
        JsonObject savedRespawn=savedDeath.session.call("respawn",obj("instanceId",savedDeath.session.instanceId,"worldId","world","username","ServerBot","sessionId",null));
        check(savedRespawn.get("connected").getAsBoolean()&&savedDeath.game.respawns==1&&savedDeath.game.creations==0,"explicit null epoch can load a death save without implicit claim");
        Fixture cleanupFailure=new Fixture();JsonObject cleanupLease=cleanupFailure.claim("a");cleanupFailure.game.immediate=false;
        JsonObject pendingAction=cleanupFailure.session.call("act",cleanupFailure.act(cleanupLease,UUID.randomUUID().toString()));
        cleanupFailure.game.crashStop=true;
        JsonObject cancelled=cleanupFailure.session.call("stop",cleanupFailure.auth(cleanupLease));
        check(cancelled.get("controlGeneration").getAsLong()==cleanupLease.get("controlGeneration").getAsLong()+1,"throwing native stop still increments generation");
        errorCode("STALE_CONTROL",()->cleanupFailure.session.call("act",cleanupFailure.act(cleanupLease,UUID.randomUUID().toString())));
        JsonObject pendingQuery=cleanupFailure.auth(cleanupLease);pendingQuery.add("operationId",pendingAction.get("operationId"));
        check(cleanupFailure.session.call("operation",pendingQuery).get("status").getAsString().equals("cancelled"),"throwing cleanup still cancels old operation");
        cleanupFailure.session.call("release",cleanupFailure.auth(cleanupLease));
        errorCode("LEASE_LOST",()->cleanupFailure.session.call("heartbeat",cleanupFailure.auth(cleanupLease)));
        JsonObject afterFailure=cleanupFailure.claim("b");check(!afterFailure.get("leaseId").equals(cleanupLease.get("leaseId")),"throwing release never leaves old lease occupied");
        cleanupFailure.time.set(ControlSession.TTL_MS);
        errorCode("LEASE_LOST",()->cleanupFailure.session.call("heartbeat",cleanupFailure.auth(afterFailure)));
        check(cleanupFailure.game.exists,"cleanup exception does not remove retained body");
        // The guard duty: a lease-bound method, not an operation; a stop keeps it, the end of the lease drops it.
        Fixture duty=new Fixture();JsonObject dutyLease=duty.claim("a");
        JsonObject guardRequest=duty.auth(dutyLease);guardRequest.addProperty("guardRevision",1);guardRequest.addProperty("player","Alex");guardRequest.addProperty("expectedEntityId",UUID.randomUUID().toString());
        errorCode("UNSUPPORTED",()->duty.session.call("guard",guardRequest));
        duty.game.guardDuty=true;
        JsonObject guarded=duty.session.call("guard",guardRequest);
        check(guarded.get("enabled").getAsBoolean()&&duty.game.guarding!=null,"guard turns the duty on");
        budget(guarded,0,"guard uses no operation ID");
        duty.session.call("stop",duty.auth(dutyLease));
        check(duty.game.guarding!=null,"a stop keeps the guard duty");
        JsonObject noLease=duty.auth(dutyLease);noLease.addProperty("leaseId",UUID.randomUUID().toString());noLease.addProperty("player","Alex");noLease.addProperty("expectedEntityId",UUID.randomUUID().toString());
        errorCode("LEASE_LOST",()->duty.session.call("guard",noLease));
        duty.session.call("release",duty.auth(dutyLease));
        check(duty.game.guarding==null&&duty.game.dutyClears>=1,"releasing the lease drops the guard duty");
        // Any stop makes the targets found before it stale (no step-aside chain any more: following never stops the body).
        TargetTokens.Target container=new TargetTokens.Target("s",4,"minecraft:overworld",net.minecraft.core.BlockPos.ZERO,List.of(),100);
        check(TargetTokens.validContext(container,"s",4,"minecraft:overworld",1)&&!TargetTokens.validContext(container,"s",5,"minecraft:overworld",1),"container tokens hold for their own generation only");
        check(!TargetTokens.validContext(container,"other",4,"minecraft:overworld",1)&&!TargetTokens.validContext(container,"s",4,"minecraft:the_nether",1)&&!TargetTokens.validContext(container,"s",4,"minecraft:overworld",100),"session, dimension and expiry invalidate container tokens");
        posture();
        interrupts();
        System.out.println("ControlSessionTest: "+checks+" checks passed");
        LocalHttpBridgeTest.run();
        ExactNbtTest.run();
        InteractionObservationTest.run();
        ApproachSafetyTest.run();
        SlotClickRulesTest.run();
        FollowCompanionTest.run();PostureTest.run();BodyTaskTest.run();TaskInterruptTest.run();
        ResourcePickupTest.run();
        CompanionMiningTest.run();
        CompanionPickupTest.run();
        NativeActionBoundaryTest.run();
        ToolAssessmentTest.run();
        SurvivalAlphaTest.run();
        NavigationTest.run();SurfaceRouteTest.run();BuildTaskTest.run();ActionMethodsTest.run();IdleGazeTest.run();LookAroundTest.run();
        DefenseAlphaTest.run();GuardCombatTest.run();GuardDutyTest.run();GuardLifecycleTest.run();
        ItemInteractionsTest.run();HostingRulesTest.run();ModAdaptersTest.run();WorkstationCoreTest.run();GenericItemSlotsTest.run();EquipmentViewTest.run();ArmourChoiceTest.run();OffhandEquipTest.run();SeatTest.run();
    }
}
