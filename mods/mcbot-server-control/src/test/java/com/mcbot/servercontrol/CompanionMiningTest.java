package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Production guard/boundary functions with deterministic live-view facts; no Minecraft launch. */
final class CompanionMiningTest {
    private static int checks;
    private static final UUID UUID_PLAYER=UUID.fromString("00000000-0000-4000-8000-000000000001");
    private static final BlockPos ORE=new BlockPos(3,1,0);
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static JsonObject args(){return obj("player","Alex","expectedEntityId",UUID_PLAYER.toString(),"maxDistance",4);}
    private static final class World implements CompanionMiningGuard.View {
        Object dimension=new Object(),playerDimension=dimension,identity=new Object();UUID uuid=UUID_PLAYER;
        Vec3 feet=new Vec3(1.5,1,0.5),player=new Vec3(0.5,1,0.5);
        boolean present=true,available=true,conflict;
        public Object dimension(){return dimension;}
        public Vec3 bodyPosition(){return feet;}
        public CompanionMiningGuard.Player companion(String name){return present?new CompanionMiningGuard.Player(identity,uuid,playerDimension,player,
            new AABB(player.x-0.3,player.y,player.z-0.3,player.x+0.3,player.y+1.8,player.z+0.3),available):null;}
        public boolean miningConflict(BlockPos position){return conflict;}
        CompanionMiningGuard guard(){return new CompanionMiningGuard(args(),this);}
    }
    private static final class Dig {
        final World world=new World();final CompanionMiningGuard guard=world.guard();
        final ControlSession.Operation operation=new ControlSession.Operation(java.util.UUID.randomUUID().toString(),"session",1,"dig-block",obj());
        final NativeActionBoundary boundary=new NativeActionBoundary();boolean stopped;int starts,finishes;
        void begin(){boundary.begin(operation,()->{guard.validateTarget(ORE);guard.validateTarget(ORE);boundary.sent();starts++;boundary.confirmed();},()->stopped=true);}
        void tick(){if(stopped||!operation.status.equals("running"))return;boundary.tick(operation,()->{guard.validateTarget(ORE);guard.validateTarget(ORE);boundary.sent();finishes++;boundary.confirmed();operation.finish("succeeded","test native receipt",obj());},()->stopped=true);}
        void fail(String code){tick();check(operation.status.equals("failed")&&operation.result.getAsJsonObject().get("code").getAsString().equals(code),"known tick guard rejection remains failed: "+code);check(stopped&&finishes==0,"guard stops before final write: "+code);int writes=starts+finishes;tick();check(starts+finishes==writes,"retired guarded dig never retries: "+code);}
    }
    static void run() {
        check(ServerController.CAPABILITIES.contains("companion-mining")&&!ServerController.atomicAction("companion-mining"),"mining guard capability is advertised, not an alternate action/control chain");
        check(CompanionMiningGuard.options(args()).maxDistance()==4,"explicit integer4 radius is accepted");
        check(CompanionMiningGuard.options(obj("player","Alex","expectedEntityId",UUID_PLAYER.toString(),"maxDistance",3)).maxDistance()==3,"explicit integer3 radius is accepted");
        check(CompanionMiningGuard.options(obj("player","Alex","expectedEntityId",UUID_PLAYER.toString(),"maxDistance",CompanionMiningGuard.MAX_DISTANCE)).maxDistance()==CompanionMiningGuard.MAX_DISTANCE,"the protection range is accepted");
        for(double distance:new double[]{2,3.5,CompanionMiningGuard.MAX_DISTANCE+0.5,CompanionMiningGuard.MAX_DISTANCE+1})errorCode("INVALID_ARGUMENT",()->CompanionMiningGuard.options(obj("player","Alex","expectedEntityId",UUID_PLAYER.toString(),"maxDistance",distance)));
        errorCode("INVALID_ARGUMENT",()->CompanionMiningGuard.options(obj("player","Alex","expectedEntityId","1-1-1-1-1","maxDistance",4)));
        errorCode("INVALID_ARGUMENT",()->CompanionMiningGuard.options(obj("player","Alex/other","expectedEntityId",UUID_PLAYER.toString(),"maxDistance",4)));
        errorCode("INVALID_ARGUMENT",()->CompanionMiningGuard.options(obj("player","Alex","expectedEntityId",UUID_PLAYER.toString())));
        var scan=NearbyResources.options(obj("blockIds",List.of("minecraft:coal_ore","minecraft:deepslate_coal_ore","minecraft:iron_ore","minecraft:deepslate_iron_ore","minecraft:copper_ore","minecraft:deepslate_copper_ore"),"companionMiningGuard",args()),new Vec3(1.5,1,0.5));
        check(scan.radius()==4&&scan.blockIds().size()==6,"guarded discovery accepts ore IDs");
        // Non-ores in a guarded request are skipped at scan time (the live #c:ores tag decides); the token issue refuses them too.
        check(NearbyResources.options(obj("blockIds",List.of("#c:ores"),"companionMiningGuard",args()),new Vec3(1.5,1,0.5)).blockIds().equals(Set.of("#c:ores")),"guarded discovery accepts the ore tag");
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of("minecraft:iron_ore"),"companionMiningGuard",args(),"center",obj("x",0,"y",0,"z",0)),Vec3.ZERO));
        errorCode("INVALID_ARGUMENT",()->NearbyResources.options(obj("blockIds",List.of("minecraft:iron_ore"),"companionMiningGuard",args(),"radius",5),Vec3.ZERO));

        World good=new World();var bound=good.guard();bound.validateBody();bound.validateTarget(ORE);
        check(bound.center().equals(good.player),"scan center comes from the bound live player's authority view");
        check(bound.allows(new Vec3(4.5,1,0.5))&&!bound.allows(new Vec3(4.5001,1,0.5)),"dynamic player radius has an exact inclusive maximum");
        check(CompanionMiningGuard.protectedBlock(new BlockPos(0,0,0),new AABB(0.2,1,0.2,0.8,2.8,0.8)),"body sole and support floor are protected");
        check(CompanionMiningGuard.protectedBlock(new BlockPos(2,1,0),new AABB(0.2,1,0.2,0.8,2.8,0.8)),"cell near body is protected even when its center is over2 away");
        check(CompanionMiningGuard.protectedBlock(ORE,new AABB(0.4,1,0.2,1,2.8,0.8)),"exact two-block cell-to-body boundary remains protected");
        check(!CompanionMiningGuard.protectedBlock(ORE,new AABB(0.2,1,0.2,0.8,2.8,0.8)),"cell beyond protection distance remains usable");
        errorCode("COMPANION_PROTECTED",()->bound.validateTarget(new BlockPos(2,1,0)));
        errorCode("COMPANION_OUT_OF_RANGE",()->bound.validateTarget(new BlockPos(5,1,0)));
        World far=new World();var farGuard=far.guard();far.feet=new Vec3(4.5001,1,0.5);errorCode("COMPANION_OUT_OF_RANGE",farGuard::validateBody);

        Dig moving=new Dig();moving.begin();moving.world.player=new Vec3(-4,1,0.5);moving.fail("COMPANION_OUT_OF_RANGE");
        Dig close=new Dig();close.begin();close.world.player=new Vec3(1.5,1,0.5);close.fail("COMPANION_PROTECTED");
        Dig replacing=new Dig();replacing.begin();replacing.world.identity=new Object();replacing.fail("STALE_COMPANION");
        Dig offline=new Dig();offline.begin();offline.world.present=false;offline.fail("STALE_COMPANION");
        Dig dead=new Dig();dead.begin();dead.world.available=false;dead.fail("STALE_COMPANION");
        Dig dimension=new Dig();dimension.begin();dimension.world.playerDimension=new Object();dimension.fail("STALE_COMPANION");
        Dig wrongUuid=new Dig();wrongUuid.begin();wrongUuid.world.uuid=java.util.UUID.randomUUID();wrongUuid.fail("STALE_COMPANION");
        Dig contested=new Dig();contested.begin();contested.world.conflict=true;contested.fail("COMPANION_MINING_CONFLICT");
        Dig refusedStart=new Dig();refusedStart.world.conflict=true;errorCode("COMPANION_MINING_CONFLICT",refusedStart::begin);check(refusedStart.starts==0,"conflict before START sends no native write");
        check(CompanionMiningGuard.miningSameCell(ORE,true,ORE,false,BlockPos.ZERO),"active destroyPos identifies another player's current mining");
        check(CompanionMiningGuard.miningSameCell(ORE,false,BlockPos.ZERO,true,ORE),"active delayedDestroyPos also conflicts");
        check(!CompanionMiningGuard.miningSameCell(ORE,false,ORE,false,ORE),"stale positions without active flags do not conflict");
        check(!CompanionMiningGuard.miningSameCell(ORE,true,BlockPos.ZERO,true,new BlockPos(4,1,0)),"other actively mined cells do not conflict");

        var target=new ResourceTargets.Target("session",1,good.dimension,ORE,null,new Object(),100,bound,List.of(new ResourceCatalog.Drop("minecraft:raw_iron","no_silk_touch",1)));
        // The source block may now be air. This production helper intentionally never reads its state.
        ResourceTargets.validatePickupAuthorization(target,new Vec3(3.4,1,0.5),"minecraft:raw_iron");
        good.player=new Vec3(2.5,1,0.5);
        errorCode("COMPANION_PROTECTED",()->bound.validateTarget(ORE));
        ResourceTargets.validatePickupAuthorization(target,new Vec3(3.4,1,0.5),"minecraft:raw_iron");
        check(true,"post-dig pickup keeps player/radius authority but does not apply mining-only minimum distance or original-state test");
        errorCode("UNSUPPORTED",()->ResourceTargets.validatePickupAuthorization(target,new Vec3(3.4,1,0.5),"minecraft:raw_copper"));
        errorCode("COMPANION_OUT_OF_RANGE",()->ResourceTargets.validatePickupAuthorization(target,new Vec3(-2,1,0.5),"minecraft:raw_iron"));
        good.player=new Vec3(0.5,1,0.5);errorCode("COMPANION_OUT_OF_RANGE",()->bound.validatePickup(ORE,new Vec3(0.3,1,0.5)));
        bound.validatePickup(ORE,new Vec3(5.2,1,0.5));check(true,"mined drop may slide past the radius within the fixed reach margin and its source neighbourhood");
        errorCode("COMPANION_OUT_OF_RANGE",()->bound.validatePickup(ORE,new Vec3(6.0001,1,0.5)));
        good.feet=new Vec3(4.5001,1,0.5);errorCode("COMPANION_OUT_OF_RANGE",()->bound.validatePickup(ORE,new Vec3(4,1,0.5)));good.feet=new Vec3(1.5,1,0.5);
        good.identity=new Object();errorCode("STALE_COMPANION",()->ResourceTargets.validatePickupAuthorization(target,new Vec3(3.4,1,0.5),"minecraft:raw_iron"));
        check(ResourceTargets.valid(target,"session",1,good.dimension,99),"pickup source token can retain its context after block removal");
        check(!ResourceTargets.valid(target,"session",1,good.dimension,100)&&!ResourceTargets.valid(target,"session",2,good.dimension,1)&&!ResourceTargets.valid(target,"other",1,good.dimension,1)&&!ResourceTargets.valid(target,"session",1,new Object(),1),"expiry, stop generation, session and dimension still invalidate pickup tokens");
        var unguarded=new ResourceTargets.Target("session",1,good.dimension,ORE,null,new Object(),100,null,List.of(new ResourceCatalog.Drop("minecraft:raw_iron","no_silk_touch",1)));
        errorCode("UNSUPPORTED",()->ResourceTargets.validatePickupAuthorization(unguarded,new Vec3(3.4,1,0.5),"minecraft:raw_iron"));
        Dig uncertain=new Dig();uncertain.begin();uncertain.world.conflict=true;uncertain.boundary.sent();uncertain.tick();
        check(uncertain.operation.status.equals("unknown"),"only a native effect already sent without confirmation turns guard failure into unknown");
        System.out.println("CompanionMiningTest: "+checks+" checks passed (production guards/boundary with deterministic views, no live-game mining)");
    }
}
