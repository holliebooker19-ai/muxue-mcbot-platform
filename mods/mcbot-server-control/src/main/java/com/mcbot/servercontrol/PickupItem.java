package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.function.LongSupplier;
import java.util.function.Predicate;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Bounded approach to one real dropped entity. Vanilla collision does the pickup, the Post event confirms it. */
final class PickupItem implements BodyTask {
    /** It ends its operation itself (fail): nothing tick throws is turned into an end for it (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return null;}
    interface View {
        boolean mayDrive();void refresh();Vec3 feet();float health();
        Object identity();JsonObject stack();Vec3 target();boolean available();boolean eligible();
        boolean safe(Vec3 from,Vec3 to);boolean inReach(Vec3 feet);List<Vec3> plan();
        void move(Vec3 delta);void stop();
        default boolean nativeNavigation(){return false;}
        default void navigate(){throw new UnsupportedOperationException();}
        default void cancelNavigation(){}
        /** Someone else drove the body: plan again from here, count damage from now. */
        default void resetNavigation(){}
        default JsonObject navigationDetails(){return null;}
        default void validateCompanion() {}
        default boolean routeAllowed(Vec3 feet) {return true;}
        /** The bound drop was discarded by vanilla merging into a nearby drop of the same item (not picked up by anyone). */
        default boolean mergedAway() {return false;}
    }
    private final ControlSession.Operation operation;
    private final View view;
    private final LongSupplier clock;
    private final Object identity;
    private final String entityId;
    private final JsonObject expected;
    private long deadline;
    private float health;
    private final GuardDuty.Grace grace;
    private final Vec3 initialTarget;
    private long progressTime;
    private Vec3 progressPosition;
    private List<Vec3> route;
    private int index,picked;
    private boolean stolen,stopped;
    private JsonObject pickedStack;
    private String storedIn;
    PickupItem(ControlSession.Operation operation,View view,LongSupplier clock) {
        this.operation=operation;this.view=view;this.clock=clock;entityId=string(operation.args,"entityId");
        try {if(!UUID.fromString(entityId).toString().equalsIgnoreCase(entityId))throw new IllegalArgumentException();}
        catch(IllegalArgumentException invalid){throw error("INVALID_ARGUMENT","entityId must be a complete UUID");}
        int count=SurvivalActions.integer(operation.args,"expectedCount");if(count<1)throw error("INVALID_ARGUMENT","expectedCount must be positive");
        expected=obj("id",string(operation.args,"expectedItem"),"count",count,"components",object(operation.args,"expectedComponents"));
        if(operation.args.has("expectedMaxStackSize")){
            int maximum=SurvivalActions.integer(operation.args,"expectedMaxStackSize");if(maximum<1)throw error("INVALID_ARGUMENT","expectedMaxStackSize must be positive");expected.addProperty("maxStackSize",maximum);
        }
        long timeout=(long)bounded(operation.args,"timeoutMs",15_000,500,30_000);
        deadline=clock.getAsLong()+timeout;grace=new GuardDuty.Grace(timeout);
        identity=view.identity();health=view.health();initialTarget=view.target();progressPosition=view.feet();progressTime=clock.getAsLong();
    }
    /** sink: the carried storage that took the items instead of the inventory, or null. */
    void picked(Object actualIdentity,boolean byBody,JsonObject stack,int count,String sink) {
        if(stopped||actualIdentity!=identity||!operation.status.equals("running"))return;
        if(!byBody){stolen=true;return;}
        if(!sameVariant(expected,stack)||count<=0||picked+count>expected.get("count").getAsInt()) {fail("PICKUP_UNKNOWN","Native pickup changed the bound item stack");return;}
        if(picked>0&&!Objects.equals(storedIn,sink)) {fail("PICKUP_UNKNOWN","Native pickup split between the inventory and carried storage");return;}
        picked+=count;storedIn=sink;pickedStack=stack.deepCopy();pickedStack.addProperty("count",picked);
    }
    boolean targets(Object actualIdentity){return !stopped&&actualIdentity==identity;}
    static boolean sameVariant(JsonObject expected,JsonObject actual) {
        return Objects.equals(expected.get("id"),actual.get("id"))&&Objects.equals(expected.get("components"),actual.get("components"))&&
            (!expected.has("maxStackSize")||Objects.equals(expected.get("maxStackSize"),actual.get("maxStackSize")));
    }
    static boolean arrivalStand(Vec3 feet,Predicate<Vec3> inReach) {
        return FlatApproach.arrivalStand(feet,inReach);
    }
    @Override public void tick() {
        if(stopped||!operation.status.equals("running")){stop();return;}
        if(!view.mayDrive()){stop();return;}
        try {
            view.validateCompanion();
            if(stolen)throw error("PICKUP_TAKEN","Another player picked up the bound drop");
            if(picked>0){operation.finish("succeeded","Native pickup attributed to this body",result(null));stop();return;}
            view.refresh();
            if(identity!=null&&!view.available()&&view.mergedAway()) throw error("PICKUP_MERGED","Bound drop merged into another drop of the same item nearby; nothing was picked up");
            if(identity==null||!view.available()||view.identity()!=identity) throw error("PICKUP_UNKNOWN","Bound dropped entity disappeared or changed; no native pickup evidence");
            JsonObject actual=view.stack();
            if(!sameVariant(expected,actual)||!Objects.equals(expected.get("count"),actual.get("count")))throw error("STALE_ITEM","Bound dropped stack changed before pickup");
            if(!view.eligible())throw error("FORBIDDEN","Drop is reserved for another player");
            if(view.health()<health)throw error("BLOCKED","Body took damage while approaching drop");
            if(view.target().distanceTo(view.feet())>8)throw error("OUT_OF_REACH","Drop must stay within eight blocks");
            if(view.target().distanceTo(initialTarget)>0.75)throw error("TARGET_MOVED","Bound drop moved; no unbounded chase");
            if(!view.nativeNavigation()&&!view.safe(view.feet(),view.feet()))throw error("BLOCKED","Body is not on safe loaded flat ground");
            long now=clock.getAsLong();if(now>=deadline)throw error("TIMEOUT","Native pickup was not confirmed within its time limit");
            if(view.nativeNavigation()){view.navigate();return;}
            if(view.inReach(view.feet())){view.stop();return;}
            if(route==null){route=view.plan();if(!view.mayDrive()){stop();return;}}
            Vec3 feet=view.feet();while(index<route.size()&&feet.subtract(route.get(index)).horizontalDistance()<0.15)index++;
            if(index>=route.size())throw error("BLOCKED","Drop moved outside the planned pickup stand");
            Vec3 from=feet;for(int i=index;i<route.size();i++){
                if(!view.routeAllowed(from)||!view.routeAllowed(route.get(i)))throw error("COMPANION_OUT_OF_RANGE","Pickup route left the live companion radius");
                if(!view.safe(from,route.get(i)))throw error("BLOCKED","Pickup route became unsafe");from=route.get(i);
            }
            if(feet.distanceToSqr(progressPosition)>0.04){progressPosition=feet;progressTime=now;}
            if(now-progressTime>2500)throw error("BLOCKED","Pickup approach made no progress");
            Vec3 delta=route.get(index).subtract(feet),step=new Vec3(delta.x,0,delta.z).normalize().scale(Math.min(0.6,delta.horizontalDistance()));
            if(!view.safe(feet,feet.add(step)))throw error("BLOCKED","Next pickup step is unsafe");
            view.validateCompanion();
            if(!view.routeAllowed(feet.add(step)))throw error("COMPANION_OUT_OF_RANGE","Next pickup step left the live companion radius");
            if(!view.mayDrive()){stop();return;}view.move(delta);
        }catch(Protocol.Error failure){fail(failure.code,failure.getMessage());}
        catch(RuntimeException failure){fail("INTERNAL","Pickup approach failed: "+failure.getClass().getSimpleName());}
    }
    private JsonObject result(String code) {
        JsonObject result=obj("entityId",entityId,"pickedUpCount",picked,"pickup",picked>0?"confirmed":"unconfirmed","requestedCount",expected.get("count").getAsInt());
        if(code==null&&!stolen)result.addProperty("remainingCount",expected.get("count").getAsInt()-picked);
        if(view.navigationDetails()!=null)result.add("navigation",view.navigationDetails());if(pickedStack!=null)result.add("stack",pickedStack.deepCopy());if(storedIn!=null)result.addProperty("storedIn",storedIn);if(code!=null)result.addProperty("code",code);return result;
    }
    /** Walking to the drop: always. Afterwards the drop must still be within reach rules (eight blocks, not moved). */
    @Override public boolean interruptible(){return !stopped;}
    @Override public void resumeAfterGuard(long fightMs){
        route=null;index=0;health=view.health();progressPosition=view.feet();progressTime=clock.getAsLong();
        view.resetNavigation();deadline+=grace.grant(fightMs);
    }
    void fail(String code,String message){operation.finish("failed",code+": "+message,result(code));stop();}
    @Override public void stop(){stopped=true;route=null;view.cancelNavigation();view.stop();}
    static PickupItem create(ControlSession.Operation operation,BodyPlayer body,ControlSession session,SurvivalActions survival,ResourceTargets resources) {
        UUID uuid;
        try {uuid=UUID.fromString(string(operation.args,"entityId"));}catch(IllegalArgumentException invalid){throw error("INVALID_ARGUMENT","entityId must be a UUID");}
        ItemEntity item=body.serverLevel().getEntity(uuid) instanceof ItemEntity drop?drop:null;
        String resourceToken=operation.args.has("resourceTargetToken")?string(operation.args,"resourceTargetToken"):null;
        ResourceTargets.Target resource=resourceToken==null?null:resources.requirePickup(body,resourceToken,item==null?body.position():item.position(),string(operation.args,"expectedItem"));
        CompanionMiningGuard mining=resource==null?null:resource.miningGuard();
        CompanionPickupGuard companion=operation.args.has("companionGuard")?new CompanionPickupGuard(object(operation.args,"companionGuard"),new CompanionPickupGuard.View(){
            public Object dimension(){return body.serverLevel();}
            public Vec3 bodyPosition(){return body.position();}
            public Vec3 itemPosition(){return item==null?body.position():item.position();}
            public CompanionPickupGuard.Player companion(String name){
                ServerPlayer player=body.getServer().getPlayerList().getPlayerByName(name);
                return player==null?null:new CompanionPickupGuard.Player(player,player.getUUID(),player.serverLevel(),player.position(),
                    player!=body&&player.isAlive()&&!player.isRemoved()&&player.connection!=null&&player.connection.isAcceptingMessages());
            }
        },mining==null?0:CompanionMiningGuard.DROP_REACH_MARGIN,mining==null?CompanionPickupGuard.MAX_DISTANCE:CompanionMiningGuard.MAX_DISTANCE):null;
        View view=new View(){
            FlatApproach geometry;
            final NativeNavigation navigation=new NativeNavigation(body,session,operation);
            public boolean mayDrive(){return session.mayDrive(operation);}
            public void refresh(){NativeNavigation.conditions(body);geometry=new FlatApproach(body);}
            public boolean nativeNavigation(){return true;}
            public void navigate(){
                validateCompanion();
                try {navigation.tick(target(),feet->routeAllowed(feet)&&inReach(feet),this::routeAllowed);}
                catch(Protocol.Error failure){if(mining!=null&&failure.code.equals("OUT_OF_REACH"))throw error("COMPANION_OUT_OF_RANGE","Ore pickup left the live companion radius");throw failure;}
            }
            public void cancelNavigation(){navigation.stop();}
            public void resetNavigation(){navigation.reset();navigation.rebaseHealth();}
            public JsonObject navigationDetails(){return navigation.diagnostics();}
            public Vec3 feet(){return body.position();}public float health(){return body.getHealth();}
            public Object identity(){return item==null?null:body.serverLevel().getEntity(uuid);}
            public boolean available(){return item!=null&&item.isAlive()&&!item.isRemoved()&&item.level()==body.serverLevel();}
            public boolean mergedAway(){
                if(item==null||item.getRemovalReason()!=net.minecraft.world.entity.Entity.RemovalReason.DISCARDED)return false;
                // The merged-away stack is already empty: compare the survivors with the requested item instead.
                JsonObject wanted=obj("id",string(operation.args,"expectedItem"),"components",object(operation.args,"expectedComponents"));
                return !body.serverLevel().getEntitiesOfClass(ItemEntity.class,item.getBoundingBox().inflate(1.5),other->other!=item&&other.isAlive()&&!other.getItem().isEmpty()&&sameVariant(wanted,survival.stackValue(other.getItem()))).isEmpty();
            }
            public boolean eligible(){return item.getTarget()==null||item.getTarget().equals(body.getUUID());}
            public JsonObject stack(){return survival.stackValue(item.getItem());}
            public Vec3 target(){return item==null?body.position():item.position();}
            public boolean safe(Vec3 from,Vec3 to){return geometry.safe(from,to);}
            public void validateCompanion(){
                if(companion!=null)companion.validate();
                if(resourceToken!=null)resources.requirePickup(body,resourceToken,target(),string(operation.args,"expectedItem"));
            }
            public boolean routeAllowed(Vec3 feet){return (companion==null||companion.allows(feet))&&(mining==null||mining.allows(feet));}
            public boolean inReach(Vec3 feet){return geometry.itemReach(feet,item.getBoundingBox());}
            public List<Vec3> plan(){
                FlatRoute.Cell origin=new FlatRoute.Cell(body.blockPosition().getX(),body.blockPosition().getZ());
                if(!routeAllowed(geometry.point(origin)))throw error("NO_PATH","Cannot enter pickup grid inside companion radius");
                if(!geometry.safe(body.position(),geometry.point(origin)))throw error("BLOCKED","Cannot safely enter pickup grid");
                return FlatRoute.plan(origin,new FlatRoute.View(){
                    public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to){return routeAllowed(geometry.point(from))&&routeAllowed(geometry.point(to))&&geometry.safe(geometry.point(from),geometry.point(to));}
                    public boolean goal(FlatRoute.Cell cell){return arrivalStand(geometry.point(cell),feet->routeAllowed(feet)&&inReach(feet));}
                }).stream().map(geometry::point).toList();
            }
            public void move(Vec3 delta){body.moveInput(delta.x,delta.z);}public void stop(){body.stopInput();}
        };
        return new PickupItem(operation,view,()->System.nanoTime()/1_000_000);
    }
}
