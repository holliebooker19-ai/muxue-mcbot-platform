package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import java.util.function.LongSupplier;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/** Bounded state-and-loaded-chunk references. Ordinary blocks have no entity-instance identity. */
final class ResourceTargets {
    static final long TTL_MS=120_000;
    static final int LIMIT=256;
    record Target(String session,long generation,Object dimension,BlockPos position,BlockState state,Object chunk,long expiresAt,CompanionMiningGuard miningGuard,List<ResourceCatalog.Drop> drops) {}
    private final ControlSession session;
    private final LongSupplier clock;
    private final LinkedHashMap<String,Target> targets=new LinkedHashMap<>();
    ResourceTargets(ControlSession session) {this(session,()->System.nanoTime()/1_000_000);}
    ResourceTargets(ControlSession session,LongSupplier clock) {this.session=session;this.clock=clock;}
    String issue(ServerPlayer body,BlockPos position,BlockState state) {
        return issue(body,position,state,null);
    }
    String issue(ServerPlayer body,BlockPos position,BlockState state,CompanionMiningGuard miningGuard) {
        List<ResourceCatalog.Drop> drops=List.of();
        if(miningGuard!=null) {
            if(!ResourceCatalog.ore(state))throw error("UNSUPPORTED","Companion mining only accepts ores (#c:ores)");
            miningGuard.validateTarget(position);
            // Pickups are authorized against what this ore really drops on this server.
            drops=ResourceCatalog.drops(body,position,state);
        }
        var chunk=body.serverLevel().getChunkSource().getChunkNow(position.getX()>>4,position.getZ()>>4);
        if(chunk==null) throw error("UNLOADED","Resource chunk is not loaded");
        targets.entrySet().removeIf(e->e.getValue().expiresAt()<=clock.getAsLong());
        while(targets.size()>=LIMIT) targets.remove(targets.keySet().iterator().next());
        String id=UUID.randomUUID().toString();targets.put(id,new Target(session.sessionId(),session.generation(),body.serverLevel(),position.immutable(),state,chunk,clock.getAsLong()+TTL_MS,miningGuard,drops));return id;
    }
    Target require(ServerPlayer body,String id) {
        Target target=requireContext(body,id);
        if(target.miningGuard()!=null)target.miningGuard().validateTarget(target.position());
        var chunk=body.serverLevel().getChunkSource().getChunkNow(target.position().getX()>>4,target.position().getZ()>>4);
        if(!chunk.getBlockState(target.position()).equals(target.state()))throw error("STALE_TARGET","Resource state changed");
        ResourceCatalog.requireSafe(body,target.position(),new FlatApproach(body));return target;
    }
    private Target requireContext(ServerPlayer body,String id) {
        Target target=targets.get(id);
        if(!valid(target,session.sessionId(),session.generation(),body.serverLevel(),clock.getAsLong())) throw error("STALE_TARGET","Resource reference expired or control changed");
        var chunk=body.serverLevel().getChunkSource().getChunkNow(target.position().getX()>>4,target.position().getZ()>>4);
        if(chunk!=target.chunk())throw error("STALE_TARGET","Resource chunk unloaded or reloaded");
        return target;
    }
    Target requirePickup(ServerPlayer body,String id,Vec3 drop,String expectedItem) {
        Target target=requireContext(body,id);
        validatePickupAuthorization(target,drop,expectedItem);return target;
    }
    static void validatePickupAuthorization(Target target,Vec3 drop,String expectedItem) {
        if(target.miningGuard()==null)throw error("UNSUPPORTED","Pickup resource token has no bound companion mining guard");
        if(!ResourceCatalog.drops(target.drops(),expectedItem))throw error("UNSUPPORTED","Pickup item is not an ordinary drop of the mined ore");
        target.miningGuard().validatePickup(target.position(),drop);
    }
    static boolean valid(Target target,String session,long generation,Object dimension,long now) {
        return target!=null&&Objects.equals(target.session(),session)&&target.generation()==generation&&target.dimension()==dimension&&now<target.expiresAt();
    }
}
