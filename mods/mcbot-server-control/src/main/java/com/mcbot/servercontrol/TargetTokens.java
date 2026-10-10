package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.LongSupplier;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.CompoundContainer;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.ChestType;
import static com.mcbot.servercontrol.Protocol.*;

/** Ephemeral identity guards. Only block identity is read; never inventory contents. */
final class TargetTokens {
    static final long TTL_MS=120_000;
    static final int LIMIT=256;
    record Part(BlockPos position,BlockState state,Object entity) {}
    record Target(String session,long generation,String dimension,BlockPos position,List<Part> parts,long expiresAt) {}
    private final ControlSession session;
    private final LongSupplier clock;
    private final LinkedHashMap<String,Target> targets=new LinkedHashMap<>();
    TargetTokens(ControlSession session) {this(session,()->System.nanoTime()/1_000_000);}
    TargetTokens(ControlSession session,LongSupplier clock) {this.session=session;this.clock=clock;}
    String issue(ServerPlayer player,BlockPos pos) {
        List<Part> parts=parts(player,pos);
        targets.entrySet().removeIf(e->e.getValue().expiresAt()<=clock.getAsLong());
        while(targets.size()>=LIMIT) targets.remove(targets.keySet().iterator().next());
        String token=UUID.randomUUID().toString();
        targets.put(token,new Target(session.sessionId(),session.generation(),dimension(player),pos,parts,clock.getAsLong()+TTL_MS));
        return token;
    }
    Target require(ServerPlayer player,String token) {
        Target target=targets.get(token);
        if(!validContext(target,session.sessionId(),session.generation(),dimension(player),clock.getAsLong()))
            throw error("STALE_TARGET","Container target expired or control/world changed; discover again");
        requireBound(player,target);
        return target;
    }
    void requireBound(ServerPlayer player,Target target) {
        // After a guarded native menu is opened, its own lifecycle retains the identity guard.
        // Discovery TTL/registry eviction cannot strand a carried stack in a valid open menu.
        if(!Objects.equals(target.session(),session.sessionId())||target.generation()!=session.generation()||!target.dimension().equals(dimension(player)))
            throw error("STALE_TARGET","Guarded menu control or dimension changed");
        List<Part> actual=parts(player,target.position());
        if(!sameParts(target.parts(),actual)) throw error("STALE_TARGET","Container block entity was replaced, reloaded or changed");
    }
    static boolean sameParts(List<Part> expected,List<Part> actual) {
        if(expected.size()!=actual.size()) return false;
        if(!sameIdentities(expected.stream().map(Part::entity).toList(),actual.stream().map(Part::entity).toList())) return false;
        for(int i=0;i<expected.size();i++) {
            Part a=expected.get(i),b=actual.get(i);
            if(!a.position().equals(b.position())||!Objects.equals(viewerless(a.state()),viewerless(b.state()))) return false;
        }
        return true;
    }
    /** Barrels and backpacks flip their "open" property while anyone views them; that is not a different container. */
    static BlockState viewerless(BlockState state) {
        return state!=null&&state.hasProperty(BlockStateProperties.OPEN)?state.setValue(BlockStateProperties.OPEN,false):state;
    }
    static boolean validContext(Target target,String session,long generation,String dimension,long now) {
        return target!=null&&target.expiresAt()>now&&Objects.equals(target.session(),session)&&target.generation()==generation&&target.dimension().equals(dimension);
    }
    static boolean sameIdentities(List<?> expected,List<?> actual) {
        if(expected.size()!=actual.size()) return false;
        for(int i=0;i<expected.size();i++) if(expected.get(i)!=actual.get(i)) return false;
        return true;
    }
    void requireMenu(ServerPlayer player,Target target,AbstractContainerMenu menu) {
        Container storage=ModAdapters.storage(menu,player.getInventory());
        if(storage==null) throw error("STALE_TARGET","Opened menu storage source is unknown");
        if(target.parts().size()==1) {
            if(!ModAdapters.storageOf(menu,storage,target.parts().getFirst().entity())) throw error("STALE_TARGET","Menu does not use the discovered block entity");
        } else if(!(storage instanceof CompoundContainer combined)||target.parts().stream().anyMatch(p->!(p.entity() instanceof Container c)||!combined.contains(c)))
            throw error("STALE_TARGET","Double chest menu does not use both discovered entities");
    }
    private static List<Part> parts(ServerPlayer player,BlockPos pos) {
        Part first=part(player,pos);List<Part> result=new ArrayList<>();result.add(first);
        if(first.state().getBlock() instanceof ChestBlock&&first.state().getValue(ChestBlock.TYPE)!=ChestType.SINGLE) {
            BlockPos other=pos.relative(ChestBlock.getConnectedDirection(first.state()));Part second=part(player,other);
            if(second.state().getBlock()!=first.state().getBlock()||second.state().getValue(ChestBlock.TYPE)==ChestType.SINGLE||
                second.state().getValue(ChestBlock.TYPE)==first.state().getValue(ChestBlock.TYPE)||second.state().getValue(ChestBlock.FACING)!=first.state().getValue(ChestBlock.FACING)||
                !other.relative(ChestBlock.getConnectedDirection(second.state())).equals(pos)) throw error("STALE_TARGET","Double chest counterpart is not intact");
            result.add(second);
        }
        return List.copyOf(result);
    }
    private static Part part(ServerPlayer player,BlockPos pos) {
        var chunk=player.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        if(chunk==null) throw error("STALE_TARGET","Container chunk unloaded");
        BlockState state=chunk.getBlockState(pos);
        if(!NearbyBlocks.ordinaryContainer(state)) throw error("STALE_TARGET","Target no longer a supported container");
        BlockEntity entity=chunk.getBlockEntity(pos);
        if(entity==null||entity.isRemoved()) throw error("STALE_TARGET","Container block entity unavailable");
        var adapter=ModAdapters.container(state);
        if(adapter!=null&&!ModAdapters.entityMatches(adapter,entity)) throw error("STALE_TARGET","Block entity does not match its pinned adapter "+adapter.id());
        return new Part(pos.immutable(),state,entity);
    }
    private static String dimension(ServerPlayer player) {return player.serverLevel().dimension().location().toString();}
}
