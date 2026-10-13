package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** The interrupt window's own rules (docs/companion_state_design.md 8.4): when it opens, what runs in it, when it closes by itself. */
final class TaskInterruptTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    static void run() {
        opening();
        lifetime();
        pickupInWindow();
        System.out.println("TaskInterruptTest: "+checks+" checks passed");
    }
    private static void opening() {
        check(TaskInterrupt.refusal(false,true,false,false)==null,"an idle body opens a window");
        check(TaskInterrupt.refusal(false,true,true,true)==null,"a task that may pause now opens a window");
        check(TaskInterrupt.refusal(false,true,true,false)!=null,"a task that cannot pause now (scaffold, mid-dig, station) does not");
        check(TaskInterrupt.refusal(false,false,false,false)!=null,"eating, digging or an open menu holds the body even with nothing running");
        check(TaskInterrupt.refusal(true,true,true,true).contains("guard"),"never while the guard drives the body");
        check(TaskInterrupt.STEPS.equals(Set.of("select-slot","swap-inventory","eat-item","defend-entity","retreat-from-entity")),"the steps are what eating and defense send");
        check(TaskInterrupt.REASONS.equals(Set.of("eat","defend")),"a window is for eating or defense");
    }
    private static void lifetime() {
        TaskInterrupt window=new TaskInterrupt("eat",null,null,1000);
        check(!window.expired(false,1000+ControlSession.TTL_MS-1),"no step yet, but within the lease time");
        check(!window.expired(true,5000)&&!window.expired(false,5000+ControlSession.TTL_MS-1),"a running step keeps it open, counted from the last tick it ran");
        check(window.expired(false,5000+ControlSession.TTL_MS),"no step for the lease time closes it");
        check(window.pausedMs(4000)==3000&&window.pausedMs(500)==0,"paused time counts from opening");
        // The paused time comes out of the task's one Grace, the same as the guard's fights: at most its own limit in all.
        GuardDuty.Grace grace=new GuardDuty.Grace(10_000);
        check(grace.grant(6000)==6000&&grace.grant(window.pausedMs(7000))==4000&&grace.grant(1000)==0,"fights and pauses share one budget");
    }
    private static JsonObject stack(int count){return obj("id","minecraft:cobblestone","count",count,"components",obj(),"maxStackSize",64);}
    private static final class DropView implements PickupItem.View {
        final AtomicLong time=new AtomicLong();final Object entity=new Object();
        boolean live=true;int moves;Vec3 feet=new Vec3(0.5,1,0.5),input;
        public boolean mayDrive(){return true;}public void refresh(){}
        public Vec3 feet(){return feet;}public float health(){return 20;}
        public Object identity(){return entity;}public JsonObject stack(){return TaskInterruptTest.stack(4);}
        public Vec3 target(){return new Vec3(4.5,1,0.5);}public boolean available(){return live;}public boolean eligible(){return true;}
        public boolean safe(Vec3 from,Vec3 to){return true;}public boolean inReach(Vec3 feet){return feet.distanceTo(target())<1.2;}
        public List<Vec3> plan(){return List.of(new Vec3(1.5,1,0.5),new Vec3(2.5,1,0.5),new Vec3(3.5,1,0.5));}
        public void move(Vec3 delta){input=delta;moves++;}public void stop(){input=null;}
    }
    private static ControlSession.Operation pickupOperation() {
        return new ControlSession.Operation(UUID.randomUUID().toString(),"session",1,"pickup-item",obj("entityId","00000000-0000-4000-8000-000000000001","expectedItem","minecraft:cobblestone","expectedCount",4,"expectedComponents",obj(),"expectedMaxStackSize",64));
    }
    /**
     * Eating or defense opens a window around a pickup-item that is walking to its drop; the body stands where it is and vanilla
     * collects the drop. The controller hands native pickup events to TaskInterrupt.pickupOf(slot, window), which must find the paused task.
     */
    private static void pickupInWindow() {
        // Which task an event is for: the slot, else the window's paused pickup; never a task that is not a pickup.
        DropView view=new DropView();ControlSession.Operation operation=pickupOperation();PickupItem pickup=new PickupItem(operation,view,view.time::get);
        BodyTask notPickup=new BodyTask(){public void tick(){}public void stop(){}public Failure failure(){return null;}public boolean interruptible(){return true;}public void resumeAfterGuard(long fightMs){}};
        check(TaskInterrupt.pickupOf(pickup,null)==pickup,"the pickup in the slot");
        check(TaskInterrupt.pickupOf(null,new TaskInterrupt("eat",operation,pickup,0))==pickup,"the slot is empty in a window: the pickup paused in it");
        check(TaskInterrupt.pickupOf(null,new TaskInterrupt("eat",null,null,0))==null&&TaskInterrupt.pickupOf(null,null)==null,"an idle window or no window: none");
        check(TaskInterrupt.pickupOf(null,new TaskInterrupt("eat",operation,notPickup,0))==null&&TaskInterrupt.pickupOf(notPickup,null)==null,"a paused or running task that is not a pickup: none");

        // The drop is collected while the pickup is paused: the resumed task reports the pickup, exactly once, and does not walk again.
        pickup.tick();
        check(operation.status.equals("running")&&view.moves==1,"the pickup walks toward its drop");
        TaskInterrupt window=new TaskInterrupt("eat",operation,pickup,view.time.get());
        view.input=null;view.time.addAndGet(2000);
        PickupItem heard=TaskInterrupt.pickupOf(null,window);
        heard.picked(view.entity,true,stack(4),4,null);                       // the Post event, delivered by ServerController.pickup()
        view.live=false;                                                       // vanilla discarded the collected entity
        pickup.resumeAfterGuard(window.pausedMs(view.time.get()));            // closeInterrupt
        pickup.tick();
        JsonObject result=operation.result==null?null:operation.result.getAsJsonObject();
        check(operation.status.equals("succeeded")&&result.get("pickedUpCount").getAsInt()==4&&result.get("pickup").getAsString().equals("confirmed"),"collected while paused: succeeded with the 4 picked up");
        check(view.moves==1&&view.input==null,"and no second walk or pickup attempt after the window");

        // Without the event reaching it (the old behaviour: no pickup in the slot), the same scene ends in PICKUP_UNKNOWN.
        DropView lost=new DropView();ControlSession.Operation lostOperation=pickupOperation();PickupItem lostPickup=new PickupItem(lostOperation,lost,lost.time::get);
        lostPickup.tick();lost.live=false;lostPickup.resumeAfterGuard(1000);lostPickup.tick();
        check(lostOperation.status.equals("failed")&&lostOperation.result.getAsJsonObject().get("code").getAsString().equals("PICKUP_UNKNOWN"),"an event that never arrives leaves PICKUP_UNKNOWN (what the fix avoids)");

        // Someone else collected it meanwhile: PICKUP_TAKEN, not PICKUP_UNKNOWN.
        DropView stolenView=new DropView();ControlSession.Operation stolenOperation=pickupOperation();PickupItem stolen=new PickupItem(stolenOperation,stolenView,stolenView.time::get);
        stolen.tick();TaskInterrupt stolenWindow=new TaskInterrupt("defend",stolenOperation,stolen,0);
        TaskInterrupt.pickupOf(null,stolenWindow).picked(stolenView.entity,false,stack(4),4,null);
        stolenView.live=false;stolen.resumeAfterGuard(500);stolen.tick();
        check(stolenOperation.status.equals("failed")&&stolenOperation.result.getAsJsonObject().get("code").getAsString().equals("PICKUP_TAKEN")&&stolenOperation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==0,"taken by someone else while paused: PICKUP_TAKEN, nothing counted for this body");

        // An event for another drop does not touch the paused task; a window that ended (the task stopped) no longer hears events.
        DropView other=new DropView();ControlSession.Operation otherOperation=pickupOperation();PickupItem otherPickup=new PickupItem(otherOperation,other,other.time::get);
        otherPickup.tick();
        check(!TaskInterrupt.pickupOf(null,new TaskInterrupt("eat",otherOperation,otherPickup,0)).targets(new Object())&&TaskInterrupt.pickupOf(null,new TaskInterrupt("eat",otherOperation,otherPickup,0)).targets(other.entity),"the paused pickup answers only for its own drop");
        otherPickup.stop();
        check(!otherPickup.targets(other.entity),"a stopped task (window closed without resuming) no longer targets the drop");
    }}
