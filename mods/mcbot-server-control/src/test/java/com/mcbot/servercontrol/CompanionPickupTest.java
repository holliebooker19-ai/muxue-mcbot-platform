package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Moving companion bounds, actual-instance identity and late Post fencing, without launching the game. */
final class CompanionPickupTest {
    private static int checks;
    private static final UUID PLAYER=UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static JsonObject stack(int count){return obj("id","minecraft:cobblestone","count",count,"maxStackSize",16,"components",obj("actual","variant"));}
    private static JsonObject args(){return obj("player","Alex","expectedEntityId",PLAYER.toString(),"maxDistance",3);}
    private static final class World implements CompanionPickupGuard.View,PickupItem.View {
        final AtomicLong clock=new AtomicLong();
        Object level=new Object(),playerLevel=level,playerIdentity=new Object(),itemIdentity=new Object();UUID uuid=PLAYER;
        Vec3 feet=new Vec3(0.5,1,0.5),player=new Vec3(-0.5,1,0.5),item=new Vec3(2.5,1,0.5),input;
        boolean playerPresent=true,playerLive=true,itemLive=true,lease=true;float health=20;int moves,plans;
        JsonObject actualStack=CompanionPickupTest.stack(4);Set<FlatRoute.Cell> wall=Set.of();List<Vec3> routeOverride;
        CompanionPickupGuard guard;
        World(boolean guarded){if(guarded)guard=new CompanionPickupGuard(args(),this);}
        public Object dimension(){return level;}public Vec3 bodyPosition(){return feet;}public Vec3 itemPosition(){return item;}
        public CompanionPickupGuard.Player companion(String name){return playerPresent?new CompanionPickupGuard.Player(playerIdentity,uuid,playerLevel,player,playerLive):null;}
        public boolean mayDrive(){return lease;}public void refresh(){}
        public Vec3 feet(){return feet;}public float health(){return health;}
        public Object identity(){return itemIdentity;}public JsonObject stack(){return actualStack;}
        public Vec3 target(){return item;}public boolean available(){return itemLive;}public boolean eligible(){return true;}
        public boolean safe(Vec3 from,Vec3 to){return !wall.contains(new FlatRoute.Cell((int)Math.floor(to.x),(int)Math.floor(to.z)));}
        public boolean inReach(Vec3 feet){return new AABB(feet.x-0.3,feet.y,feet.z-0.3,feet.x+0.3,feet.y+1.8,feet.z+0.3).inflate(1,0.5,1).intersects(new AABB(item.x-0.125,item.y,item.z-0.125,item.x+0.125,item.y+0.25,item.z+0.125));}
        public void validateCompanion(){if(guard!=null)guard.validate();}
        public boolean routeAllowed(Vec3 feet){return guard==null||guard.allows(feet);}
        public List<Vec3> plan(){
            plans++;if(routeOverride!=null)return routeOverride;
            FlatRoute.Cell origin=new FlatRoute.Cell((int)Math.floor(feet.x),(int)Math.floor(feet.z));
            return FlatRoute.plan(origin,new FlatRoute.View(){
                public boolean edge(FlatRoute.Cell from,FlatRoute.Cell to){return routeAllowed(point(from))&&routeAllowed(point(to))&&safe(point(from),point(to));}
                public boolean goal(FlatRoute.Cell cell){return FlatApproach.arrivalStand(point(cell),p->routeAllowed(p)&&inReach(p));}
            }).stream().map(World::point).toList();
        }
        private static Vec3 point(FlatRoute.Cell cell){return new Vec3(cell.x()+0.5,1,cell.z()+0.5);}
        public void move(Vec3 delta){input=delta;moves++;}public void stop(){input=null;}
    }
    private record Fixture(World world,ControlSession.Operation operation,PickupItem pickup){
        Fixture(boolean guarded){this(new World(guarded));}
        Fixture(World world){this(world,new ControlSession.Operation(UUID.randomUUID().toString(),"session",1,"pickup-item",obj("entityId","00000000-0000-4000-8000-000000000002","expectedItem","minecraft:cobblestone","expectedCount",4,"expectedComponents",stack(4).get("components"),"expectedMaxStackSize",16)));}
        Fixture(World world,ControlSession.Operation op){this(world,op,new PickupItem(op,world,world.clock::get));}
        void fail(String code){pickup.tick();check(operation.status.equals("failed")&&operation.result.getAsJsonObject().get("code").getAsString().equals(code),"guarded pickup fails "+code);check(world.input==null,"guard failure clears physical input");int moves=world.moves;pickup.tick();check(world.moves==moves,"guard failure cannot retry a retired pickup");}
    }
    static void run(){
        check(ServerController.CAPABILITIES.contains("companion-pickup")&&!ServerController.atomicAction("companion-pickup"),"guard capability is advertised but has no act entry point");
        check(ServerController.atomicAction("pickup-item")&&!ServerController.atomicAction("nearby-resources"),"existing pickup remains atomic and discovery remains read-only");
        World valid=new World(true);valid.guard.validate();check(valid.guard.allows(new Vec3(2.5,1,0.5))&&!valid.guard.allows(new Vec3(2.5001,1,0.5)),"inclusive live companion radius is exact rather than an eight-block pickup fallback");
        World bodyFar=new World(true);bodyFar.feet=new Vec3(3,1,0.5);Fixture farStart=new Fixture(bodyFar);farStart.fail("COMPANION_OUT_OF_RANGE");check(bodyFar.moves==0&&bodyFar.plans==0,"initial body outside guard rejects before planning or input");
        World itemFar=new World(true);itemFar.item=new Vec3(2.5001,1,0.5);Fixture farDrop=new Fixture(itemFar);farDrop.fail("COMPANION_OUT_OF_RANGE");check(itemFar.moves==0,"initial drop outside player radius rejects before input");
        World minedDrop=new World(false);minedDrop.item=new Vec3(2,1,2.6);minedDrop.guard=new CompanionPickupGuard(args(),minedDrop,CompanionMiningGuard.DROP_REACH_MARGIN,CompanionMiningGuard.MAX_DISTANCE);minedDrop.guard.validate();
        check(minedDrop.guard.allows(new Vec3(2.5,1,0.5))&&!minedDrop.guard.allows(new Vec3(2.5001,1,0.5)),"mined-drop margin widens only where the drop rests, never the body route");
        Fixture minedReach=new Fixture(minedDrop);minedReach.pickup.tick();check(minedDrop.input!=null&&minedDrop.guard.allows(minedDrop.feet),"drop past the radius is still approached from inside it");
        minedDrop.item=new Vec3(4.0001,1,0.5);errorCode("COMPANION_OUT_OF_RANGE",minedDrop.guard::validate);

        Fixture moved=new Fixture(true);moved.pickup.tick();check(moved.world.input!=null,"valid guarded pickup begins ordinary movement");moved.world.player=moved.world.player.add(-3,0,0);moved.fail("COMPANION_OUT_OF_RANGE");
        Fixture replacement=new Fixture(true);replacement.pickup.tick();replacement.world.playerIdentity=new Object();replacement.fail("STALE_COMPANION");
        Fixture wrongUuid=new Fixture(true);wrongUuid.world.uuid=UUID.fromString("00000000-0000-4000-8000-000000000003");wrongUuid.fail("STALE_COMPANION");
        Fixture offline=new Fixture(true);offline.world.playerPresent=false;offline.fail("STALE_COMPANION");
        Fixture dead=new Fixture(true);dead.world.playerLive=false;dead.fail("STALE_COMPANION");
        Fixture dimension=new Fixture(true);dimension.world.playerLevel=new Object();dimension.fail("STALE_COMPANION");

        Set<FlatRoute.Cell> wall=Set.of(new FlatRoute.Cell(1,-2),new FlatRoute.Cell(1,-1),new FlatRoute.Cell(1,0),new FlatRoute.Cell(1,1),new FlatRoute.Cell(1,2));
        World boundedWorld=new World(true);boundedWorld.wall=wall;Fixture bounded=new Fixture(boundedWorld);bounded.fail("NO_PATH");check(bounded.world.moves==0,"a detour outside companion range is never selected");
        World legacyWorld=new World(false);legacyWorld.wall=wall;Fixture legacy=new Fixture(legacyWorld);legacy.pickup.tick();check(legacy.operation.status.equals("running")&&legacy.world.moves==1,"legacy pickup without guard can still use the original bounded obstacle route");

        World changingRoute=new World(true);changingRoute.routeOverride=List.of(changingRoute.feet,new Vec3(-2.5,1,1.5),new Vec3(1.5,1,0.5));
        Fixture changed=new Fixture(changingRoute);changed.pickup.tick();check(changingRoute.input!=null,"initial route can use in-range detour");changingRoute.player=new Vec3(0.5,1,0.5);changed.fail("COMPANION_OUT_OF_RANGE");
        check(changingRoute.feet.distanceTo(changingRoute.player)<=3&&changingRoute.item.distanceTo(changingRoute.player)<=3,"remaining route guard stops even while body and target themselves remain in radius");

        Fixture actual=new Fixture(true);actual.pickup.tick();actual.pickup.picked(actual.world.itemIdentity,true,stack(2),2,null);actual.world.player=actual.world.player.add(-3,0,0);actual.fail("COMPANION_OUT_OF_RANGE");
        JsonObject partial=actual.operation.result.getAsJsonObject();check(partial.get("pickedUpCount").getAsInt()==2&&partial.get("pickup").getAsString().equals("confirmed")&&partial.getAsJsonObject("stack").get("count").getAsInt()==2,"out-of-range after native Post keeps actually acquired portion without declaring unguarded success");
        Fixture identityAfterPost=new Fixture(true);identityAfterPost.pickup.picked(identityAfterPost.world.itemIdentity,true,stack(4),4,null);identityAfterPost.world.playerIdentity=new Object();identityAfterPost.fail("STALE_COMPANION");
        check(identityAfterPost.operation.result.getAsJsonObject().get("pickedUpCount").getAsInt()==4,"companion replacement after Post retains truthful full count while refusing mode continuation");
        Fixture success=new Fixture(true);success.pickup.picked(success.world.itemIdentity,true,stack(4),4,null);success.world.itemLive=false;success.pickup.tick();check(success.operation.status.equals("succeeded")&&success.world.input==null,"native pickup succeeds after discard only while companion guard remains valid");
        Fixture stopped=new Fixture(true);stopped.pickup.tick();stopped.operation.finish("cancelled","stop",null);stopped.pickup.stop();int before=stopped.world.moves;stopped.pickup.picked(stopped.world.itemIdentity,true,stack(4),4,null);stopped.pickup.tick();check(stopped.operation.status.equals("cancelled")&&stopped.world.moves==before&&stopped.world.input==null,"late Post after cancellation cannot resurrect the old guarded pickup");

        JsonObject missing=args();missing.remove("maxDistance");errorCode("INVALID_ARGUMENT",()->new CompanionPickupGuard(missing,new World(false)));
        for(double radius:new double[]{1.49,4.01}){JsonObject invalid=args();invalid.addProperty("maxDistance",radius);errorCode("INVALID_ARGUMENT",()->new CompanionPickupGuard(invalid,new World(false)));}
        JsonObject shortUuid=args();shortUuid.addProperty("expectedEntityId","1-1-1-1-1");errorCode("INVALID_ARGUMENT",()->new CompanionPickupGuard(shortUuid,new World(false)));
        JsonObject invalidName=args();invalidName.addProperty("player","Alex Other");errorCode("INVALID_ARGUMENT",()->new CompanionPickupGuard(invalidName,new World(false)));
        for(double radius:new double[]{1.5,4}){JsonObject boundary=args();boundary.addProperty("maxDistance",radius);new CompanionPickupGuard(boundary,new World(false));check(true,"guard radius boundary accepted "+radius);}
        // A mined ore's drop is picked up as far out as the ore was (the companion mining range), a plain pickup still beside the player.
        JsonObject mined=args();mined.addProperty("maxDistance",CompanionMiningGuard.MAX_DISTANCE);new CompanionPickupGuard(mined,new World(false),CompanionMiningGuard.DROP_REACH_MARGIN,CompanionMiningGuard.MAX_DISTANCE);check(true,"a mined drop's guard takes the mining range");
        errorCode("INVALID_ARGUMENT",()->new CompanionPickupGuard(mined,new World(false)));
        System.out.println("CompanionPickupTest: "+checks+" checks passed");
    }
}
