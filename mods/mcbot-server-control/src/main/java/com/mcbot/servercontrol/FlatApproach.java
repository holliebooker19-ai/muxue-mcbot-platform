package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.*;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.*;
import net.minecraft.world.phys.shapes.*;
import static com.mcbot.servercontrol.Protocol.*;

/** Loaded-only native geometry: flat follow sweeps, reach and visibility checks. Routes come from NativeNavigation. */
final class FlatApproach implements BlockGetter {
    static final int MAX_READS=150_000;
    private final ServerPlayer player;
    private final double y;
    private int reads;
    private boolean missing,throughLeaves;
    private final Map<BlockPos,BlockState> states=new HashMap<>();
    private final Map<BlockPos,VoxelShape> collisions=new HashMap<>();
    FlatApproach(ServerPlayer player) {this.player=player;this.y=player.getY();}
    int reads(){return reads;}
    static boolean arrivalStand(Vec3 feet,Predicate<Vec3> goal) {
        // Waypoints are accepted within 0.15 blocks. Require the complete 0.2 square
        // to meet the original native reach/LOS predicate before selecting a stand.
        if(!goal.test(feet))return false;
        for(double x:new double[]{-0.2,0.2})for(double z:new double[]{-0.2,0.2})
            if(!goal.test(feet.add(x,0,z)))return false;
        return true;
    }
    Vec3 point(FlatRoute.Cell cell) {return new Vec3(cell.x()+0.5,y,cell.z()+0.5);}
    boolean clear(Vec3 from,Vec3 to) {
        missing=false;
        AABB body=player.getBoundingBox().move(from.subtract(player.position())).deflate(0.0001);
        AABB sweep=body.minmax(body.move(to.subtract(from)));
        for(int x=(int)Math.floor(sweep.minX)-1;x<=(int)Math.floor(sweep.maxX)+1;x++)
            for(int z=(int)Math.floor(sweep.minZ)-1;z<=(int)Math.floor(sweep.maxZ)+1;z++)
                for(int by=(int)Math.floor(sweep.minY)-1;by<=(int)Math.floor(sweep.maxY)+1;by++) {
                    BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);if(missing)return false;
                    if(collides(sweep,collision(pos,state).move(x,by,z)))return false;
                    if(hazard(state)&&new AABB(x,by,z,x+1,by+1,z+1).intersects(sweep.inflate(0,0.025,0)))return false;
                    if(missing)return false;
                }
        return !missing&&player.serverLevel().getEntities(player,sweep,e->e.isAlive()&&(e instanceof net.minecraft.world.entity.LivingEntity||e.canBeCollidedWith())).isEmpty();
    }
    BlockState loaded(BlockPos pos) {
        BlockState cached=states.get(pos);if(cached!=null)return cached;
        if(++reads>MAX_READS) throw error("PATH_BUDGET","Loaded terrain read budget exhausted");
        if(player.serverLevel().isOutsideBuildHeight(pos)||!player.serverLevel().getWorldBorder().isWithinBounds(pos)) {missing=true;return Blocks.AIR.defaultBlockState();}
        var chunk=player.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        if(chunk==null) {missing=true;return Blocks.AIR.defaultBlockState();}
        BlockState state=chunk.getBlockState(pos);states.put(pos.immutable(),state);return state;
    }
    private VoxelShape collision(BlockPos pos,BlockState state){
        VoxelShape cached=collisions.get(pos);if(cached!=null)return cached;
        VoxelShape shape=state.getCollisionShape(this,pos,CollisionContext.of(player));
        if(!missing)collisions.put(pos.immutable(),shape);return shape;
    }
    BlockState requireLoaded(BlockPos pos) {
        missing=false;BlockState state=loaded(pos);
        if(missing)throw error("UNLOADED","Resource neighbourhood is outside loaded terrain");
        return state;
    }
    boolean safe(Vec3 from,Vec3 to) {
        if(Math.abs(from.y-y)>0.05||Math.abs(to.y-y)>0.05) return false;
        missing=false;
        AABB body=player.getBoundingBox().move(from.subtract(player.position())).deflate(0.0001);
        AABB end=body.move(to.subtract(from));
        AABB sweep=body.minmax(end);
        // Scan one extra neighbour layer because collision shapes may extend outside their cell.
        int minX=(int)Math.floor(sweep.minX)-1,maxX=(int)Math.floor(sweep.maxX)+1;
        int minY=(int)Math.floor(sweep.minY)-1,maxY=(int)Math.floor(sweep.maxY)+1;
        int minZ=(int)Math.floor(sweep.minZ)-1,maxZ=(int)Math.floor(sweep.maxZ)+1;
        VoxelShape sole=Shapes.create(new AABB(sweep.minX,y-0.025,sweep.minZ,sweep.maxX,y-0.001,sweep.maxZ));
        VoxelShape support=Shapes.empty();
        for(int x=minX;x<=maxX;x++) for(int z=minZ;z<=maxZ;z++) for(int by=minY;by<=maxY;by++) {
            BlockPos pos=new BlockPos(x,by,z);BlockState state=loaded(pos);
            if(missing) return false;
            VoxelShape shape=collision(pos,state).move(x,by,z);
            if(collides(sweep,shape)) return false;
            support=Shapes.or(support,shape);
            AABB dangerBox=new AABB(x,by,z,x+1,by+1,z+1);
            if(dangerBox.intersects(sweep)||dangerBox.intersects(new AABB(sweep.minX,y-0.03,sweep.minZ,sweep.maxX,y,sweep.maxZ)))
                if(hazard(state)) return false;
            if(missing) return false;
        }
        if(missing||!supported(sole,support)) return false;
        // Real entity bounds (including players) must not be crossed by the swept body.
        return player.serverLevel().getEntities(player,sweep,e->e.isAlive()&&(e instanceof net.minecraft.world.entity.LivingEntity||e.canBeCollidedWith())).isEmpty();
    }
    static boolean collides(AABB swept,VoxelShape obstacle) {return Shapes.joinIsNotEmpty(Shapes.create(swept),obstacle,BooleanOp.AND);}
    static boolean supported(VoxelShape sole,VoxelShape support) {return !Shapes.joinIsNotEmpty(sole,support,BooleanOp.ONLY_FIRST);}
    boolean containerReach(Vec3 feet,BlockPos pos) {
        missing=false;Vec3 eye=feet.add(0,player.getEyeHeight(),0);
        BlockHitResult hit=clip(new ClipContext(eye,Vec3.atCenterOf(pos),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(pos)&&eye.distanceTo(hit.getLocation())<=player.blockInteractionRange();
    }
    boolean blockVisible(BlockPos pos) {
        missing=false;
        BlockHitResult hit=clip(new ClipContext(player.getEyePosition(),Vec3.atCenterOf(pos),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(pos);
    }
    /** Line of sight where only leaves are in the way: a log inside a tree crown, cleared leaf by leaf before digging. */
    boolean blockVisibleThroughLeaves(BlockPos pos) {throughLeaves=true;try{return blockVisible(pos);}finally{throughLeaves=false;}}
    boolean reachThroughLeaves(Vec3 feet,BlockPos pos) {throughLeaves=true;try{return containerReach(feet,pos);}finally{throughLeaves=false;}}
    String itemVisibility(Vec3 destination) {
        missing=false;
        BlockHitResult hit=clip(new ClipContext(player.getEyePosition(),destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return missing?"unknown":hit.getType()==HitResult.Type.MISS?"visible":"occluded";
    }
    boolean itemReach(Vec3 feet,AABB item) {
        AABB body=player.getBoundingBox().move(feet.subtract(player.position())).inflate(1,0.5,1);
        return body.intersects(item);
    }
    /**
     * approach-player's check on the recipient each tick: null while fine. A fixed approach (no track) fails once the player
     * moved more than half a block; a tracking one follows the player and only gives up beyond the navigation range (the
     * same 32 blocks follow-player uses), so catching up is limited by the approach's own time limit.
     */
    static String recipientProblem(boolean track,Vec3 start,Vec3 current,Vec3 body) {
        if(!track) return current.distanceTo(start)>0.5?"TARGET_MOVED":null;
        return current.distanceTo(body)>32?"OUT_OF_REACH":null;
    }
    boolean playerReach(Vec3 feet,ServerPlayer target,double distance) {
        if(feet.distanceTo(target.position())>distance) return false;
        missing=false;
        BlockHitResult hit=clip(new ClipContext(feet.add(0,player.getEyeHeight(),0),target.getEyePosition(),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        return !missing&&hit.getType()==HitResult.Type.MISS;
    }
    static boolean hazard(BlockState state) {
        return !state.getFluidState().isEmpty()||state.is(Blocks.MAGMA_BLOCK)||state.is(Blocks.CACTUS)||state.is(Blocks.FIRE)||state.is(Blocks.SOUL_FIRE)||state.is(Blocks.SWEET_BERRY_BUSH)||state.is(Blocks.POWDER_SNOW)||state.is(Blocks.WITHER_ROSE)||state.is(Blocks.CAMPFIRE)||state.is(Blocks.SOUL_CAMPFIRE);
    }
    @Override public BlockState getBlockState(BlockPos pos) {BlockState state=loaded(pos);return throughLeaves&&state.is(net.minecraft.tags.BlockTags.LEAVES)?Blocks.AIR.defaultBlockState():state;}
    @Override public FluidState getFluidState(BlockPos pos) {return loaded(pos).getFluidState();}
    @Override public BlockEntity getBlockEntity(BlockPos pos) {missing=true;return null;}
    @Override public int getHeight() {return player.serverLevel().getHeight();}
    @Override public int getMinBuildHeight() {return player.serverLevel().getMinBuildHeight();}
}
