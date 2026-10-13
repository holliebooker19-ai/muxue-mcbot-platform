package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.*;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** The standing guard duty over a scripted body: when it takes the body, hands it back, walks back and counts fight time. */
final class GuardDutyTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static final class FakeView implements GuardDuty.View {
        long time;Vec3 feet=new Vec3(0,64,0),companion=new Vec3(3,64,0),walkedTo;
        boolean mayDrive=true,noWayBack;int walks,walkStops;
        public long now(){return time;}
        public Vec3 position(){return feet;}
        public Vec3 companion(){return companion;}
        public boolean mayDrive(){return mayDrive;}
        public boolean walkBack(Vec3 spot){if(noWayBack)throw error("NO_PATH","no way");walks++;walkedTo=spot;return false;}
        public void stopWalking(){walkStops++;}
    }
    /** A fight that wants the body while `foe` is set, and moves the body as it fights. */
    private static final class FakeCombat implements GuardDuty.Combat {
        final FakeView view;boolean foe;int ticks,stops;
        FakeCombat(FakeView view){this.view=view;}
        public boolean tick(Vec3 companion){ticks++;if(foe)view.feet=view.feet.add(1,0,0);return foe;}
        public boolean foesNear(Vec3 companion){return foe;}
        public void stop(){stops++;}
        public JsonObject json(){return obj("state",foe?"fighting":"idle","hits",0,"kills",0,"shots",0,"retreats",0,"damage",0);}
    }
    private static GuardDuty duty(FakeView view,FakeCombat combat){return new GuardDuty("Alex",UUID.randomUUID(),GuardCombat.Options.parse(JsonParser.parseString("true")),view,combat);}
    static void run() {
        idleFight();
        coverage();
        handOver();
        interruptedTick();
        taskPause();
        wouldFight();
        fightEnd();
        System.out.println("GuardDutyTest: "+checks+" checks passed");
    }
    /** A running task: the duty waits while it cannot stand aside, fights when it can, never walks back, and the fight time is what extends the task. */
    private static void taskPause() {
        GuardDuty.Grace grace=new GuardDuty.Grace(1000);
        check(grace.grant(400)==400&&grace.grant(500)==500&&grace.grant(300)==100&&grace.grant(50)==0,"fights extend a task by at most its own time limit");
        check(new GuardDuty.Grace(1000).grant(-5)==0,"no negative extension");
        check(GuardDuty.bodyFree(false,false,false,true,true,false),"the fight's own bow draw or raised shield does not make the body busy (it would be lowered the next tick)");
        check(!GuardDuty.bodyFree(false,false,false,true,false,false),"an item someone else is using (a meal) keeps the body");
        check(!GuardDuty.bodyFree(true,false,false,false,true,false)&&!GuardDuty.bodyFree(false,true,false,false,true,false)&&!GuardDuty.bodyFree(false,false,true,false,true,false)&&!GuardDuty.bodyFree(false,false,false,false,true,true),"eating, a native write, sleep and an open menu keep the body even mid-fight");
        check(GuardDuty.bodyFree(false,false,false,false,false,false),"an idle body is free");
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        combat.foe=true;
        check(!duty.tick(false,false)&&combat.ticks==0,"a task that cannot stand aside keeps the body: the fight is not even looked at");
        check(duty.json().get("covering").getAsBoolean()==false&&"BUSY".equals(duty.json().get("reason").getAsString()),"observation says why it does not cover");
        check(duty.tick(true,false)&&duty.fighting()&&duty.driving(),"an interruptible task gives the body to the fight");
        view.time+=3000;check(duty.tick(true,false),"still fighting");
        combat.foe=false;view.time+=500;
        check(!duty.tick(true,false)&&!duty.driving()&&view.walks==0,"after the fight the body goes back to the task, not to a spot");
        check(duty.busyMs()==3500,"the fight time the task is extended by: "+duty.busyMs());
    }
    /** What gets a seated body up: the duty's own rules, so sitting has no range of its own. */
    private static void wouldFight() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        check(!duty.wouldFight(true),"no foe around the player: stay seated");
        combat.foe=true;check(duty.wouldFight(true),"a foe the guard would fight: get up");
        view.companion=new Vec3(GuardDuty.ENGAGE_RANGE+1,64,0);check(!duty.wouldFight(true),"the player is beyond the guard's reach: the guard would not fight, so stay");
        view.companion=new Vec3(3,64,0);view.mayDrive=false;check(!duty.wouldFight(true),"no control: stay");
        view.mayDrive=true;view.companion=null;check(!duty.wouldFight(true),"player away: stay");
        view.companion=new Vec3(3,64,0);duty.stop();check(!duty.wouldFight(true),"duty off: stay");
        check(combat.ticks==0,"asking never fights");
        // Something holds the body (an open menu, a meal, a window): tick() would refuse with BUSY, so a seated body must not get up for it.
        FakeView held=new FakeView();FakeCombat foe=new FakeCombat(held);foe.foe=true;GuardDuty waiting=duty(held,foe);
        check(!waiting.wouldFight(false),"a foe near but the body is held: the guard would not fight this tick, so stay seated");
        check(!waiting.tick(false,false)&&"BUSY".equals(waiting.json().get("reason").getAsString())&&foe.ticks==0,"and tick() agrees: BUSY, no fight");
        check(waiting.wouldFight(true)&&waiting.tick(true,false)&&foe.ticks==1,"the body free again: it would fight, and tick() does");
    }
    /** The one way a fight ends (DutyFight): shared by the duty finishing it and by the duty being turned off or replaced in the middle of it. */
    private static void fightEnd() {
        final class Back implements DutyFight.Handback {
            final List<String> calls=new ArrayList<>();
            public void resumeTask(long extendMs){calls.add("task:"+extendMs);}
            public void resumeBody(){calls.add("body");}
        }
        ControlSession.Operation gather=new ControlSession.Operation("a","s",1,"pickup-item",obj()),other=new ControlSession.Operation("b","s",1,"move-to-position",obj());
        // A task was running when the fight began: it resumes and gets exactly the fight's length (the path clearDuty took without this: nothing).
        DutyFight fight=new DutyFight();Back back=new Back();
        check(!fight.driving()&&!fight.end(5000,gather,back)&&back.calls.isEmpty(),"no fight on: ending hands nothing back");
        fight.drove(1000,gather);fight.drove(1300,gather);
        check(fight.driving(),"the duty drives");
        check(fight.end(1700,gather,back)&&back.calls.equals(List.of("task:700"))&&!fight.driving(),"fight over with the paused task still running: it resumes with the whole fight added");
        check(!fight.end(1800,gather,back)&&back.calls.size()==1,"a second end (clearDuty after tickDuty) hands nothing back twice");
        // The operation in the slot is not the one that was paused (it started later, or the paused one ended): resumes, no extra time.
        fight.drove(2000,gather);back.calls.clear();
        check(fight.end(2500,other,back)&&back.calls.equals(List.of("task:0")),"another operation runs now: it resumes with no time added");
        // Idle when the fight began, then an operation began in the middle: it waits for the fight like a paused one, from when it began.
        fight.drove(3000,null);fight.began(other,3200);back.calls.clear();
        check(fight.end(3500,other,back)&&back.calls.equals(List.of("task:300")),"an operation begun mid-fight gets the time since it began");
        // Idle all through: the body is handed back to the posture.
        fight.drove(4000,null);back.calls.clear();
        check(fight.end(4600,null,back)&&back.calls.equals(List.of("body")),"nothing runs: the body and the posture get it back");
        // Not fighting: began() records nothing, and a later fight starts fresh.
        fight.began(other,4700);fight.drove(5000,gather);back.calls.clear();
        check(fight.end(5100,gather,back)&&back.calls.equals(List.of("task:100")),"began() outside a fight is ignored; the next fight is its own");
        // Everything stopped: no fight, nothing resumes.
        fight.drove(6000,gather);fight.reset();back.calls.clear();
        check(!fight.driving()&&!fight.end(6100,gather,back)&&back.calls.isEmpty(),"a stop forgets the fight");
        // A task that throws while resuming leaves no fight behind.
        fight.drove(7000,gather);
        try{fight.end(7100,gather,new DutyFight.Handback(){public void resumeTask(long extendMs){throw new IllegalStateException();}public void resumeBody(){}});check(false,"the fault goes up");}
        catch(IllegalStateException expected){check(!fight.driving(),"but the fight is already over");}
        // The extension is what the task's Grace grants: the paused task's limit moves by the fight, once.
        GuardDuty.Grace grace=new GuardDuty.Grace(1000);long[] deadline={10_000};
        fight.drove(8000,gather);fight.end(8400,gather,new DutyFight.Handback(){public void resumeTask(long extendMs){deadline[0]+=grace.grant(extendMs);}public void resumeBody(){}});
        check(deadline[0]==10_400,"the paused task's deadline moves by the fight's length");
    }
    private static void idleFight() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        check(!duty.tick(true,true)&&!duty.driving()&&duty.json().get("covering").getAsBoolean(),"nothing to fight: the body is left alone, the player is covered");
        Vec3 start=view.feet;
        combat.foe=true;
        check(duty.tick(true,true)&&duty.fighting(),"a foe while idle: the duty takes the body");
        view.time+=1000;duty.tick(true,true);view.time+=1000;
        combat.foe=false;
        check(duty.tick(true,true)&&view.walkedTo.equals(start)&&duty.json().get("returning").getAsBoolean(),"after an idle fight it walks back to where it stood");
        check(duty.busyMs()==2000,"fight time is counted");
        view.feet=start;
        check(!duty.tick(true,true)&&!duty.driving()&&view.walkStops==1,"back at the spot: the walk ends and the body is free again");
        // A walk back with no way gives up instead of standing stuck.
        combat.foe=true;duty.tick(true,true);duty.tick(true,true);duty.tick(true,true);combat.foe=false;view.noWayBack=true;
        check(!duty.tick(true,true)&&!duty.driving(),"no way back: it stays where the fight left it");
    }
    private static void coverage() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        combat.foe=true;
        view.companion=null;
        check(!duty.tick(true,true)&&duty.json().get("reason").getAsString().equals("PLAYER_AWAY")&&combat.ticks==0,"player offline or away: not covered, no fight");
        view.companion=new Vec3(GuardDuty.ENGAGE_RANGE+1,64,0);
        check(!duty.tick(true,true)&&duty.json().get("reason").getAsString().equals("TOO_FAR"),"more than 16 blocks from the player: only self-defense, no fight");
        view.companion=new Vec3(3,64,0);
        check(!duty.tick(false,false)&&duty.json().get("reason").getAsString().equals("BUSY")&&combat.ticks==0,"what runs cannot be interrupted: the duty waits");
        check(duty.tick(true,false)&&combat.ticks==1&&!duty.json().has("reason"),"the player came back: protecting again");
        view.mayDrive=false;
        check(!duty.tick(true,true)&&combat.stops==1&&!duty.fighting(),"control lost: the fight is dropped");
    }
    private static void handOver() {
        FakeView view=new FakeView();FakeCombat combat=new FakeCombat(view);GuardDuty duty=duty(view,combat);
        combat.foe=true;
        check(duty.tick(true,false),"a foe during a follow: the duty takes the body");
        combat.foe=false;
        check(!duty.tick(true,false)&&view.walks==0,"with something else to go back to (a follow) it does not walk back itself");
        combat.foe=true;duty.tick(true,true);
        check(!duty.tick(false,false)&&combat.stops==1&&!duty.fighting(),"a task that cannot be interrupted starts: the fight is dropped and the body handed over");
        combat.foe=true;duty.tick(true,true);duty.interrupt();
        check(!duty.fighting()&&combat.stops==2,"a stop drops the fight but keeps the duty");
        check(duty.tick(true,true),"and the duty fights again on the next tick");
        duty.stop();
        check(combat.stops>=3&&!duty.driving(),"turning it off stops the fight");
    }
    private static void interruptedTick() {
        for(boolean off:new boolean[]{false,true}) {
            FakeView view=new FakeView();GuardDuty[] current={null};boolean[] interrupt={true};int[] stops={0};
            GuardDuty.Combat combat=new GuardDuty.Combat(){
                public boolean tick(Vec3 companion){if(interrupt[0]){interrupt[0]=false;if(off)current[0].stop();else current[0].interrupt();}return true;}
                public boolean foesNear(Vec3 companion){return true;}
                public void stop(){stops[0]++;}
                public JsonObject json(){return obj("state","idle");}
            };
            current[0]=new GuardDuty("Alex",UUID.randomUUID(),GuardCombat.Options.parse(JsonParser.parseString("true")),view,combat);
            check(!current[0].tick(true,true)&&!current[0].driving()&&!current[0].fighting(),"native callback cannot resurrect the interrupted tick");
            check(stops[0]>0,"even the first combat tick is cancelled before fighting was recorded");
            check(current[0].tick(true,true)!=off,off?"a removed duty never drives again":"an ordinary stop permits a fresh tick");
        }
    }

}
