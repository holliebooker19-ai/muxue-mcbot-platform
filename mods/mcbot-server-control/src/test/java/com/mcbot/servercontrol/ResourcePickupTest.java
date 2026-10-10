package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

final class ResourcePickupTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static JsonObject stack(int count,int maximum){return obj("id",count==0?"minecraft:air":"minecraft:cobblestone","count",count,"components",count==0?obj():obj("actual",obj("type","byte","value",1)),"maxStackSize",maximum);}
    private static final class View implements PickupItem.View {
        final AtomicLong time=new AtomicLong();Object entity=new Object();
        JsonObject stack=ResourcePickupTest.stack(4,64);Vec3 feet=new Vec3(0.5,1,0.5),target=new Vec3(4.5,1,0.5),input;
        boolean live=true,safe=true,lease=true,eligible=true,planExpires,merged;float health=20;int moves,plans;
        Predicate<Vec3> reachOverride;List<Vec3> routeOverride;
        public boolean mayDrive(){return lease;}public void refresh(){}
        public Vec3 feet(){return feet;}public float health(){return health;}
        public Object identity(){return entity;}public JsonObject stack(){return stack;}
        public Vec3 target(){return target;}public boolean available(){return live;}public boolean eligible(){return eligible;}
        public boolean safe(Vec3 from,Vec3 to){return safe;}public boolean inReach(Vec3 feet){return reachOverride!=null?reachOverride.test(feet):feet.distanceTo(target)<1.2;}
        public List<Vec3> plan(){plans++;if(planExpires)lease=false;return routeOverride!=null?routeOverride:List.of(new Vec3(1.5,1,0.5),new Vec3(2.5,1,0.5),new Vec3(3.5,1,0.5));}
        public void move(Vec3 delta){input=delta;moves++;}public void stop(){input=null;}
        public boolean mergedAway(){return merged;}
    }
    private record Fixture(View view,ControlSession.Operation operation,PickupItem pickup) {
        Fixture(){this(new View());}
        Fixture(View view){this(view,new ControlSession.Operation(UUID.randomUUID().toString(),"session",1,"pickup-item",obj("entityId","00000000-0000-4000-8000-000000000001","expectedItem","minecraft:cobblestone","expectedCount",4,"expectedComponents",stack(4,64).get("components"),"expectedMaxStackSize",64)));}
        Fixture(View view,ControlSession.Operation op){this(view,op,new PickupItem(op,view,view.time::get));}
        void failure(String code){pickup.tick();check(operation.status.equals("failed")&&operation.result.getAsJsonObject().get("code").getAsString().equals(code),"pickup fails with "+code);check(view.input==null,"failure stops physical input");int moves=view.moves;pickup.tick();check(view.moves==moves,"failed pickup never automatically retries");}
    }
    static void run(){
        check(ResourceCatalog.selector("minecraft:stone")&&ResourceCatalog.selector("example:maple_log")&&ResourceCatalog.selector("#c:ores")&&ResourceCatalog.selector("#minecraft:logs"),"block IDs and block tags (modded too) are resource selectors");
        check(!ResourceCatalog.selector("stone")&&!ResourceCatalog.selector("#ores")&&!ResourceCatalog.selector("Minecraft:Stone")&&!ResourceCatalog.selector("##c:ores"),"selectors must be namespaced IDs or tags");
        check(ResourceCatalog.protectsPlayer(BlockPos.ZERO,new AABB(0.2,1,0.2,0.8,2.8,0.8)),"block supporting whole player sole cannot be a resource");
        check(ResourceCatalog.protectsPlayer(BlockPos.ZERO,new AABB(0.2,0.7,0.2,0.8,2.5,0.8)),"block intersecting another player cannot be dug");
        check(!ResourceCatalog.protectsPlayer(BlockPos.ZERO,new AABB(1.2,1,0.2,1.8,2.8,0.8)),"adjacent wall resource does not equal player support");
        check(!ResourceCatalog.atOrAboveFeet(new BlockPos(3,200,3),new Vec3(0.5,201,0.5)),"visible surrounding platform floor is never a gather target");
        check(ResourceCatalog.atOrAboveFeet(new BlockPos(3,201,3),new Vec3(0.5,201,0.5)),"authorized wall resource at feet plane remains eligible");
        check(ResourceCatalog.atOrAboveFeet(new BlockPos(3,202,3),new Vec3(0.5,201.01,0.5))&&!ResourceCatalog.atOrAboveFeet(new BlockPos(3,200,3),new Vec3(0.5,201.01,0.5)),"fractional feet height never authorizes a lower floor block");
        Vec3 origin=new Vec3(0.5,1,0.5);
        NearbyResources.Options options=NearbyResources.options(obj("blockIds",List.of("minecraft:stone"),"radius",6,"maxResults",64),origin);
        check(options.radius()==6&&options.maxResults()==64&&options.center().equals(origin),"bounded default scan center preserves exact body position");
        NearbyResources.Options ores=NearbyResources.options(obj("blockIds",List.of("minecraft:coal_ore","minecraft:deepslate_coal_ore","minecraft:iron_ore","minecraft:deepslate_iron_ore","minecraft:copper_ore","minecraft:deepslate_copper_ore")),origin);
        check(ores.blockIds().size()==6&&ores.radius()==4&&ores.maxResults()==32&&ores.center().equals(origin),"six explicit ore IDs enter the same frozen bounded discovery entrance");
        check(NearbyResources.options(obj("blockIds",List.of("#c:ores","example:maple_log")),origin).blockIds().size()==2,"tags and modded IDs enter discovery; the live catalog decides at scan time");
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of("copper_ore")),origin));
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of()),origin));
        check(NearbyResources.options(obj("blockIds",List.of("minecraft:stone"),"radius",16),origin).radius()==16,"scan reaches sixteen blocks");
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of("minecraft:stone"),"radius",17),origin));
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of("minecraft:stone"),"center",obj("x",9,"y",1,"z",0)),origin));
        Object dimension=new Object();var target=new ResourceTargets.Target("session",1,dimension,BlockPos.ZERO,null,new Object(),100,null,List.of());
        check(ResourceTargets.valid(target,"session",1,dimension,99),"resource ref live in bound epoch");
        check(!ResourceTargets.valid(target,"session",1,dimension,100)&&!ResourceTargets.valid(target,"session",2,dimension,1)&&!ResourceTargets.valid(target,"session",1,new Object(),1),"expiry stop generation and real dimension invalidate references");
        check(!ResourceTargets.valid(target,"other",1,dimension,1),"another body session invalidates a reference");
        JsonObject dropPosition=obj("x",3,"y",201.25,"z",3),dropStack=stack(1,99);
        JsonObject airborne=ServerController.groundObservation("drop",dropPosition,dropStack,"visible",false);
        JsonObject grounded=ServerController.groundObservation("drop",dropPosition,dropStack,"visible",true);
        check(!airborne.get("onGround").getAsBoolean()&&grounded.get("onGround").getAsBoolean(),"identical drop positions at flight apex and on ground retain different native landing flags");
        check(airborne.getAsJsonObject("stack").equals(dropStack)&&grounded.getAsJsonObject("position").equals(dropPosition)&&grounded.get("entityId").getAsString().equals("drop"),"landing observation preserves complete stack maximum components position and identity guards");
        check(ServerController.groundObservation("drop",dropPosition,dropStack,"unknown",false).get("visible").isJsonNull(),"unknown loaded-only visibility does not invent visibility from landing state");

        PickupLedger ledger=new PickupLedger();JsonObject first=ledger.record("item",obj("x",1,"y",1,"z",1),stack(4,64),stack(1,64),"session",1,"overworld",null);
        check(first.get("pickedUpCount").getAsInt()==3&&first.getAsJsonObject("stack").get("count").getAsInt()==3,"native partial pickup count uses original minus remaining not whole entity");
        check(first.getAsJsonObject("stack").get("maxStackSize").getAsInt()==64&&first.getAsJsonObject("stack").getAsJsonObject("components").equals(stack(4,64).get("components")),"pickup receipt preserves actual variant and effective stack maximum");
        PickupLedger highMaximum=new PickupLedger();JsonObject highReceipt=highMaximum.record("large",obj(),stack(99,99),stack(0,99),"session",1,"overworld",null);
        check(highReceipt.get("pickedUpCount").getAsInt()==99&&highReceipt.getAsJsonObject("stack").get("maxStackSize").getAsInt()==99,"native quantity above64 is retained exactly without atomic-drop limit truncation");
        check(PickupLedger.pickedUpCount(stack(4,64),stack(0,64))==4,"complete pickup handles empty current stack before count refill");
        errorCode("PICKUP_UNKNOWN",()->PickupLedger.pickedUpCount(stack(4,64),stack(4,64)));
        errorCode("PICKUP_UNKNOWN",()->PickupLedger.pickedUpCount(stack(4,64),stack(5,64)));
        errorCode("PICKUP_UNKNOWN",()->PickupLedger.pickedUpCount(stack(4,64),stack(1,16)));
        for(int i=0;i<PickupLedger.LIMIT;i++)ledger.record("item"+i,obj(),stack(1,99),stack(0,99),"session",1,"overworld",null);
        JsonObject history=ledger.observation();
        check(history.getAsJsonArray("pickupReceipts").size()==256&&history.get("pickupCursor").getAsInt()==257&&history.get("pickupOldestCursor").getAsInt()==1,"bounded receipt history exposes exact lower cursor for gap rejection");
        JsonObject stored=new PickupLedger().record("item",obj(),stack(4,64),stack(0,64),"session",1,"overworld","sophisticatedbackpacks:backpack");
        check(stored.get("storedIn").getAsString().equals("sophisticatedbackpacks:backpack")&&!first.has("storedIn"),"receipts name a carried storage destination and omit it for the inventory");
        ledger.unknown();check(ledger.observation().getAsJsonArray("pickupReceipts").isEmpty()&&ledger.observation().get("pickupOldestCursor").getAsInt()==258,"unattributable native event creates visible receipt gap instead of invented count");

        Fixture normal=new Fixture();normal.pickup.tick();check(normal.operation.status.equals("running")&&normal.view.moves==1,"pickup owns a running ordinary movement operation");
        normal.pickup.picked(normal.view.entity,true,stack(4,64),4,null);normal.view.live=false;normal.pickup.tick();
        check(normal.operation.status.equals("succeeded")&&normal.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==4&&normal.view.input==null,"matching native Post confirms pickup even after entity discard");
        Fixture absent=new Fixture();absent.view.live=false;absent.failure("PICKUP_UNKNOWN");
        check(absent.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==0&&absent.operation.result.getAsJsonObject().get("pickup").getAsString().equals("unconfirmed"),"unknown disappearance never counts as received");
        Fixture merged=new Fixture();merged.view.live=false;merged.view.merged=true;merged.failure("PICKUP_MERGED");
        check(merged.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==0,"a drop merged into a neighbour is a plain failure with nothing picked, not an unknown outcome");
        Fixture other=new Fixture();other.pickup.picked(other.view.entity,false,stack(4,64),4,null);other.failure("PICKUP_TAKEN");
        Fixture replacement=new Fixture();replacement.view.entity=new Object();replacement.failure("PICKUP_UNKNOWN");
        Fixture changed=new Fixture();changed.view.stack=stack(3,64);changed.failure("STALE_ITEM");
        Fixture maximum=new Fixture();maximum.view.stack=stack(4,16);maximum.failure("STALE_ITEM");
        Fixture danger=new Fixture();danger.view.safe=false;danger.failure("BLOCKED");
        Fixture health=new Fixture();health.view.health=19;health.failure("BLOCKED");
        Fixture reserved=new Fixture();reserved.view.eligible=false;reserved.failure("FORBIDDEN");
        Fixture moved=new Fixture();moved.view.target=moved.view.target.add(1,0,0);moved.failure("TARGET_MOVED");
        Fixture expired=new Fixture();expired.view.time.set(15000);expired.failure("TIMEOUT");
        Fixture stopped=new Fixture();stopped.pickup.tick();stopped.pickup.stop();int moves=stopped.view.moves;stopped.pickup.picked(stopped.view.entity,true,stack(4,64),4,null);stopped.pickup.tick();
        check(stopped.view.input==null&&stopped.view.moves==moves&&stopped.operation.status.equals("running"),"retired pickup cannot consume late Post or resume input; session owns cancellation metadata");
        Fixture lost=new Fixture();lost.view.planExpires=true;lost.pickup.tick();check(lost.view.moves==0&&lost.view.input==null,"lease lost during route plan cannot emit late input");
        Fixture sunk=new Fixture();sunk.pickup.picked(sunk.view.entity,true,stack(4,64),4,"sb:backpack");sunk.view.live=false;sunk.pickup.tick();
        check(sunk.operation.status.equals("succeeded")&&sunk.operation.result.getAsJsonObject().get("storedIn").getAsString().equals("sb:backpack"),"pickup into a carried storage succeeds and says where the items went");
        check(!normal.operation.result.getAsJsonObject().has("storedIn"),"an inventory pickup carries no storage destination");
        Fixture split=new Fixture();split.pickup.picked(split.view.entity,true,stack(2,64),2,"sb:backpack");split.pickup.picked(split.view.entity,true,stack(2,64),2,null);
        check(split.operation.status.equals("failed")&&split.operation.result.getAsJsonObject().get("code").getAsString().equals("PICKUP_UNKNOWN"),"a pickup split between inventory and carried storage is unknown");
        Fixture partial=new Fixture();partial.pickup.picked(partial.view.entity,true,stack(2,64),2,null);partial.pickup.tick();
        check(partial.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==2&&partial.operation.result.getAsJsonObject().get("remainingCount").getAsInt()==2,"partial native pickup reports only actual count and remaining portion");
        // A barely-intersecting cell used to end a route before a 0.15-tolerance arrival
        // actually touched the item. Use vanilla's exact body inflation for this boundary.
        AABB dropBounds=new AABB(4.799,1,0.375,5.049,1.25,0.625);
        Predicate<Vec3> trueReach=feet->new AABB(feet.x-0.3,feet.y,feet.z-0.3,feet.x+0.3,feet.y+1.8,feet.z+0.3).inflate(1,0.5,1).intersects(dropBounds);
        Vec3 barely=new Vec3(3.5,1,0.5),premature=new Vec3(3.36,1,0.5);
        check(trueReach.test(barely)&&!trueReach.test(premature)&&premature.distanceTo(barely)<0.15,"old waypoint-end boundary reproduces true pickup miss within route tolerance");
        check(!PickupItem.arrivalStand(barely,trueReach),"barely intersecting native pickup stand is rejected for planning");
        List<FlatRoute.Cell> cells=FlatRoute.plan(new FlatRoute.Cell(3,0),new FlatRoute.View(){
            public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to){return true;}
            public boolean goal(FlatRoute.Cell cell){return PickupItem.arrivalStand(new Vec3(cell.x()+0.5,1,cell.z()+0.5),trueReach);}
        });
        check(cells.getLast().equals(new FlatRoute.Cell(4,0)),"bounded planner chooses the interior cell with arrival margin");
        Vec3 planned=new Vec3(4.5,1,0.5);
        for(double x:new double[]{-0.149,0,0.149})for(double z:new double[]{-0.149,0,0.149})check(trueReach.test(planned.add(x,0,z)),"every endpoint tolerance corner still intersects actual vanilla pickup bounds");
        View arrivalView=new View();arrivalView.feet=premature;arrivalView.target=new Vec3(4.924,1,0.5);arrivalView.reachOverride=trueReach;
        arrivalView.routeOverride=cells.stream().map(cell->new Vec3(cell.x()+0.5,1,cell.z()+0.5)).toList();
        Fixture arrival=new Fixture(arrivalView);arrival.pickup.tick();
        check(arrival.operation.status.equals("running")&&arrival.view.input!=null,"tolerated first waypoint cannot prematurely exhaust the interior pickup route");
        arrival.view.feet=planned.add(-0.14,0,0);arrival.view.time.set(50);arrival.pickup.tick();
        check(arrival.operation.status.equals("running")&&arrival.view.input==null,"actual reach waits for physical Post and never declares virtual pickup success");
        arrival.pickup.picked(arrival.view.entity,true,stack(4,64),4,null);arrival.view.live=false;arrival.view.time.set(100);arrival.pickup.tick();
        check(arrival.operation.status.equals("succeeded")&&arrival.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==4,"next physical-tick native Post confirms quantity after entity removal");
        System.out.println("ResourcePickupTest: "+checks+" checks passed");
    }
}
