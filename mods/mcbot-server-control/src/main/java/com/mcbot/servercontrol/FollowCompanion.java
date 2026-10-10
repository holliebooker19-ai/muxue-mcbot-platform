package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.RandomSource;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Walking for the follow posture ({@link Posture}): toward one player, waiting beside them, now and then a short stroll.
 * Not an operation: it never finishes on its own. A player out of reach is "away", no route is "blocked"; both are retried
 * every tick (away) or after a pause (blocked). Only another person behind the followed name ends it (STALE_TARGET).
 */
final class FollowCompanion {
    record Target(UUID uuid,Object dimension,Vec3 position,boolean available) {}
    interface View {
        /** Recheck walking conditions for this tick; throws (BLOCKED...) when the body cannot walk now. */
        void refresh();
        Vec3 position();
        Object dimension();
        /** The online player by this name, or null. */
        Target target(String name);
        /** One walking tick toward the player; true once within `distance`. Throws NO_PATH and other walking errors. */
        boolean navigate(Vec3 target,double distance);
        void cancelNavigation();
        void stop();
        /** A standable spot STROLL_MIN..STROLL_MAX blocks around the centre, or null. */
        Vec3 strollPoint(Vec3 centre);
        /** Walk one tick toward a stroll spot, never leaving the stroll area around the centre; true once there. */
        boolean stroll(Vec3 point,Vec3 centre);
        void endStroll();
        /** The guard drove the body elsewhere: the follow route is stale. */
        void resetNavigation();
        default JsonObject navigationDetails(){return null;}
    }
    // The player may stand where no walking route reaches (a roof, a pillar): wait and look again once they move or a few seconds pass.
    static final double UNREACHABLE_SHIFT=2;
    static final long UNREACHABLE_RETRY_MS=3000;
    // Idle stroll: after standing by a still player for a while, walk a few steps somewhere nearby and stay there
    // until the player moves. Never with pickup or mining (the runtime turns wander off for those).
    static final long STROLL_AFTER_MS=8_000,STROLL_SPREAD_MS=10_000,STROLL_LIMIT_MS=10_000,STROLL_RETRY_MS=5_000;
    static final double STROLL_MIN=2.5,STROLL_MAX=4.5,STROLL_LEASH=1.5;
    final String name;
    final UUID expected;
    final double distance;
    final boolean wander;
    private final View view;
    private final LongSupplier clock;
    private final Random random;
    private String state="following",reason;
    private boolean arrived;
    private Vec3 unreachableTarget;
    private long unreachableSince;
    private Vec3 waitAnchor,strollAnchor,stroll;
    private long nextStroll,strollDeadline;

    FollowCompanion(String name,UUID expected,double distance,boolean wander,View view,LongSupplier clock,Random random) {
        this.name=name;this.expected=expected;this.distance=distance;this.wander=wander;this.view=view;this.clock=clock;this.random=random;
    }
    /** One tick. True while it moves the body (walking or strolling); false standing beside the player, away or blocked. */
    boolean tick() {
        long now=clock.getAsLong();
        Target actual=view.target(name);
        if(actual!=null&&actual.available()&&!expected.equals(actual.uuid())) throw error("STALE_TARGET","The followed name now belongs to someone else");
        if(actual==null||!actual.available()||actual.dimension()!=view.dimension()||actual.position().distanceTo(view.position())>GuardDuty.PLAYER_RANGE) {
            halt();publish("away","PLAYER_AWAY");return false;
        }
        if(unreachableTarget!=null&&actual.position().distanceTo(unreachableTarget)<=UNREACHABLE_SHIFT&&now-unreachableSince<UNREACHABLE_RETRY_MS) return false;
        unreachableTarget=null;
        try {
            view.refresh();
            if(strollAnchor!=null&&actual.position().distanceTo(strollAnchor)>STROLL_LEASH)endStroll(now,false);
            if(strollAnchor!=null) {
                // Strolling, or resting where the stroll ended, while the player stays put.
                arrived=true;publish("following",null);
                if(stroll!=null) {
                    boolean done;
                    try {done=view.stroll(stroll,strollAnchor)||now>=strollDeadline;}
                    catch(Protocol.Error blocked) {done=true;}
                    if(!done)return true;
                    view.endStroll();view.stop();stroll=null;nextStroll=now+STROLL_AFTER_MS+random.nextLong(STROLL_SPREAD_MS);
                    return false;
                }
                view.stop();startStroll(now,actual.position());return stroll!=null;
            }
            arrived=view.navigate(actual.position(),distance);
            publish("following",null);
            if(!arrived){waitAnchor=null;return true;}
            if(waitAnchor==null||actual.position().distanceTo(waitAnchor)>1){waitAnchor=actual.position();nextStroll=now+STROLL_AFTER_MS+random.nextLong(STROLL_SPREAD_MS);}
            startStroll(now,actual.position());
            return stroll!=null;
        } catch(Protocol.Error failure) {
            halt();unreachableTarget=actual.position();unreachableSince=now;publish("blocked",failure.code);return false;
        }
    }
    private void publish(String next,String why){state=next;reason=why;if(!next.equals("following"))arrived=false;}
    private void startStroll(long now,Vec3 centre) {
        if(!wander||now<nextStroll)return;
        Vec3 point=view.strollPoint(centre);
        if(point==null){nextStroll=now+STROLL_RETRY_MS;return;}
        stroll=point;strollAnchor=centre;strollDeadline=now+STROLL_LIMIT_MS;
    }
    private void endStroll(long now,boolean rest) {
        if(stroll!=null){view.endStroll();view.stop();stroll=null;}
        if(!rest)strollAnchor=null;
        nextStroll=now+STROLL_AFTER_MS+random.nextLong(STROLL_SPREAD_MS);
    }
    /** Someone spoke: stop strolling and stay where the body is, so it can turn to them. */
    void holdStroll(){if(stroll!=null||strollAnchor!=null||waitAnchor!=null)endStroll(clock.getAsLong(),true);}
    boolean strolling(){return stroll!=null;}
    /** Something else took the body (a fight, an operation): the stroll and the pause after a missed route are forgotten. */
    void standAside() {
        if(stroll!=null||strollAnchor!=null)endStroll(clock.getAsLong(),false);
        waitAnchor=null;unreachableTarget=null;halt();
    }
    /** The body comes back from somewhere else: plan the route again from where it stands. */
    void resume(){view.resetNavigation();}
    /** Stop moving now; the posture stays. */
    void halt() {
        if(stroll!=null)view.endStroll();stroll=null;strollAnchor=null;
        try {view.cancelNavigation();} finally {view.stop();}
    }
    String state(){return state;}
    String reason(){return reason;}
    boolean arrived(){return arrived;}
    JsonObject navigationDetails(){return view.navigationDetails();}

    static FollowCompanion create(String player,UUID expected,double distance,boolean wander,BodyPlayer body,BooleanSupplier mayDrive,MinecraftServer server) {
        View view=new View() {
            FlatApproach geometry;
            final NativeNavigation navigation=new NativeNavigation(body,mayDrive).tolerateDamage();
            final RandomSource random=RandomSource.create();
            NativeNavigation strollNavigation;
            public void refresh() {NativeNavigation.conditions(body);geometry=new FlatApproach(body);}
            public Vec3 position() {return body.position();}
            public Object dimension() {return body.serverLevel();}
            public Target target(String name) {
                ServerPlayer target=server.getPlayerList().getPlayerByName(name);
                return target==null?null:new Target(target.getUUID(),target.serverLevel(),target.position(),
                    target!=body&&target.isAlive()&&!target.isRemoved()&&target.connection!=null&&target.connection.isAcceptingMessages());
            }
            public boolean navigate(Vec3 target,double distance){return navigation.tick(target,feet->geometry.playerReach(feet,server.getPlayerList().getPlayerByName(player),distance));}
            // reset, not stop: a stopped navigation never walks again, and the posture walks on later.
            public void cancelNavigation(){navigation.reset();endStroll();}
            public void stop() {body.stopInput();}
            public Vec3 strollPoint(Vec3 centre){return navigation.strollPoint(centre,STROLL_MIN,STROLL_MAX,random);}
            public boolean stroll(Vec3 point,Vec3 centre) {
                if(strollNavigation==null)strollNavigation=new NativeNavigation(body,mayDrive).tolerateDamage();
                return strollNavigation.tick(point,feet->feet.subtract(point).horizontalDistance()<=0.6&&Math.abs(feet.y-point.y)<1,
                    p->p.subtract(centre).horizontalDistance()<=STROLL_MAX+2);
            }
            public void endStroll(){if(strollNavigation!=null)strollNavigation.stop();strollNavigation=null;}
            public void resetNavigation(){navigation.reset();endStroll();}
            public JsonObject navigationDetails(){return navigation.diagnostics();}
        };
        return new FollowCompanion(player,expected,distance,wander,view,()->System.nanoTime()/1_000_000,new Random());
    }
}
