package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.StructureTags;
import net.minecraft.world.Container;
import net.minecraft.world.level.block.state.BlockState;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Which blocks may belong to somebody's building (10-13). The server cannot tell a player's wall from natural stone, so it
 * recognises what it can and only reports: a block is "maybe a building" when it
 * <ul>
 * <li>lies inside a piece of a vanilla village (the pieces, not the structure's bounding box that takes in the fields around),</li>
 * <li>is, or lies within hand reach of, a place somebody lives in: a bed, a door, or a block entity with an inventory
 *     (chest, barrel, furnace, shulker box, hopper...; decided by the block entity, not a list of block IDs),</li>
 * <li>lies within hand reach of the home the runtime sends along (a remembered place named home).</li>
 * </ul>
 * Blocks the body placed itself (the pillar it stands on, a placed block) are never reported. Nothing here refuses anything:
 * dig-block only stops when the caller asks it to check (buildingCheck) and the runtime lets the model decide; a scan
 * leaves such blocks out and counts them. "Within hand reach" is the body's own block interaction range (the distance
 * every dig, placement and container open of the body is already limited to), taken from the player so no other number exists.
 * Pure logic over BlockPos and a World; Live reads a real level.
 */
final class BuildingGuard {
    enum Reason {
        VILLAGE("village"),LIVED_IN("lived_in"),HOME("home");
        final String wire;
        Reason(String wire){this.wire=wire;}
    }
    /** What the level is asked; Live answers from a loaded level, tests answer from a list. */
    interface World {
        boolean villagePiece(BlockPos pos);
        /** A bed, a door or a block with an inventory stands here. */
        boolean dwelling(BlockPos pos);
    }
    /** The runtime's remembered home (feet position of the player who said "this is home"). */
    record Home(double x,double y,double z) {}

    private final World world;
    private final double near;
    private final Home home;
    private final Predicate<BlockPos> own;
    private final List<BlockPos> dwellings;
    private BuildingGuard(World world,double near,Home home,Predicate<BlockPos> own,List<BlockPos> dwellings) {
        this.world=world;this.near=near;this.home=home;this.own=own;this.dwellings=dwellings;
    }

    /** A guard for blocks inside the box min..max (inclusive): the dwellings within reach of that box are looked up once. */
    static BuildingGuard around(World world,double near,Home home,Predicate<BlockPos> own,BlockPos min,BlockPos max) {
        int reach=(int)Math.ceil(near);List<BlockPos> found=new ArrayList<>();
        for(int x=min.getX()-reach;x<=max.getX()+reach;x++)for(int y=min.getY()-reach;y<=max.getY()+reach;y++)for(int z=min.getZ()-reach;z<=max.getZ()+reach;z++){
            BlockPos pos=new BlockPos(x,y,z);if(world.dwelling(pos))found.add(pos);
        }
        return new BuildingGuard(world,near,home,own,found);
    }

    /**
     * A scan's candidates without the ones that may be a building; returns how many were left out. The dwellings are looked up
     * once for the box around all candidates, not once per candidate.
     */
    static <T> int leaveOut(List<T> items,java.util.function.Function<T,BlockPos> at,World world,double near,Home home,Predicate<BlockPos> own) {
        if(items.isEmpty())return 0;
        int lx=Integer.MAX_VALUE,ly=Integer.MAX_VALUE,lz=Integer.MAX_VALUE,hx=Integer.MIN_VALUE,hy=Integer.MIN_VALUE,hz=Integer.MIN_VALUE;
        for(T item:items){BlockPos p=at.apply(item);lx=Math.min(lx,p.getX());ly=Math.min(ly,p.getY());lz=Math.min(lz,p.getZ());hx=Math.max(hx,p.getX());hy=Math.max(hy,p.getY());hz=Math.max(hz,p.getZ());}
        BuildingGuard guard=around(world,near,home,own,new BlockPos(lx,ly,lz),new BlockPos(hx,hy,hz));
        int before=items.size();
        items.removeIf(item->guard.reason(at.apply(item))!=null);
        return before-items.size();
    }

    /** Why this block may be a building, or null. A block the body placed itself is never one. */
    Reason reason(BlockPos pos) {
        if(own.test(pos))return null;
        if(world.villagePiece(pos))return Reason.VILLAGE;
        for(BlockPos dwelling:dwellings)if(close(pos,dwelling.getX()+0.5,dwelling.getY()+0.5,dwelling.getZ()+0.5))return Reason.LIVED_IN;
        if(home!=null&&close(pos,home.x(),home.y(),home.z()))return Reason.HOME;
        return null;
    }
    private boolean close(BlockPos pos,double x,double y,double z) {
        double dx=pos.getX()+0.5-x,dy=pos.getY()+0.5-y,dz=pos.getZ()+0.5-z;
        return dx*dx+dy*dy+dz*dz<=near*near;
    }

    /** The home in a request's "home" ({dimension,x,y,z}) when it is in this dimension; null when absent or elsewhere. */
    static Home home(JsonObject args,String dimension) {
        if(!args.has("home"))return null;
        JsonObject home=object(args,"home");
        if(!string(home,"dimension").equals(dimension))return null;
        return new Home(number(home,"x"),number(home,"y"),number(home,"z"));
    }

    /** The answer for the real game: loaded chunks only (an unloaded cell is neither). */
    static final class Live implements World {
        private final ServerLevel level;
        Live(ServerLevel level){this.level=level;}
        @Override public boolean villagePiece(BlockPos pos) {
            return loaded(pos)&&level.structureManager().getStructureWithPieceAt(pos,StructureTags.VILLAGE).isValid();
        }
        @Override public boolean dwelling(BlockPos pos) {
            if(level.isOutsideBuildHeight(pos))return false;
            var chunk=level.getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
            if(chunk==null)return false;
            BlockState state=chunk.getBlockState(pos);
            if(state.is(BlockTags.BEDS)||state.is(BlockTags.DOORS))return true;
            return state.hasBlockEntity()&&chunk.getBlockEntity(pos) instanceof Container;
        }
        private boolean loaded(BlockPos pos){return !level.isOutsideBuildHeight(pos)&&level.getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4)!=null;}
    }
}
