package com.mcbot.servercontrol;

import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Which logs make up one tree. Logs touching one another (also diagonally: a slanted acacia trunk, a 2x2 trunk)
 * form a piece. A piece with a log standing on the ground (soil, stone, mangrove roots: not a log, leaves or air)
 * is a trunk; a piece up in the air (a branch past a gap in the leaves, a cherry or acacia limb, a jungle branch)
 * belongs to the trunk it is nearest to within BRANCH_REACH blocks, so two trees standing side by side stay two
 * trees even where their crowns touch. Pieces that reach no trunk (what is left of a tree whose base was cut) group
 * among themselves the same way and count as one tree.
 * A tree has a crown: one of its logs touches leaves (or the wart blocks and shroomlights of a huge fungus). Logs
 * with none, a village house wall, a fence or a stump, are no tree and are left alone (10-12 a house wall was cut
 * as the tree beside the player).
 */
final class TreeScan {
    static final int BRANCH_REACH=4,SPREAD=10,BELOW=4,ABOVE=40,MAX_LOGS=256;
    record Tree(List<BlockPos> logs,boolean truncated) {}

    /** Tree ids (0, 1, ...) for logs already found, grouped by the rule above. */
    static Map<BlockPos,Integer> group(ServerLevel level,Collection<BlockPos> logs) {
        List<Set<BlockPos>> pieces=pieces(new HashSet<>(logs));
        int[] owner=attach(level,pieces);
        Map<Integer,Integer> ids=new HashMap<>();Map<BlockPos,Integer> result=new HashMap<>();
        for(int i=0;i<pieces.size();i++){int root=owner[i]<0?i:owner[i];int id=ids.computeIfAbsent(root,k->ids.size());for(BlockPos p:pieces.get(i))result.put(p,id);}
        return result;
    }

    /**
     * The whole trees nearest a point, nearest first (up to `count`): every requested log within radius+SPREAD
     * across and BELOW below to ABOVE above, grouped as above; a tree is a candidate when one of its logs lies within
     * radius and BELOW below to 8 above the point. Loaded chunks only; at most MAX_LOGS logs in all.
     */
    static Tree nearest(ServerLevel level,Vec3 center,int radius,ResourceCatalog.Selection selection,int count) {
        BlockPos origin=BlockPos.containing(center);
        List<Set<BlockPos>> pieces=pieces(region(level,center,radius,selection));int[] owner=attach(level,pieces);
        Set<Integer> crowned=crowned(level,pieces,owner);
        Map<Integer,Double> distance=new HashMap<>();
        for(int i=0;i<pieces.size();i++){int root=owner[i]<0?i:owner[i];if(!crowned.contains(root))continue;
            for(BlockPos p:pieces.get(i)){int dx=p.getX()-origin.getX(),dz=p.getZ()-origin.getZ(),dy=p.getY()-origin.getY();
                if(dx*dx+dz*dz<=radius*radius&&dy>=-BELOW&&dy<=8)distance.merge(root,Vec3.atCenterOf(p).distanceTo(center),Math::min);}}
        List<Integer> roots=new ArrayList<>(distance.keySet());roots.sort(Comparator.comparingDouble(distance::get));
        List<BlockPos> chosen=new ArrayList<>();
        for(int root:roots.subList(0,Math.min(count,roots.size()))){
            List<BlockPos> tree=new ArrayList<>();
            for(int i=0;i<pieces.size();i++)if(i==root||owner[i]==root)tree.addAll(pieces.get(i));
            tree.sort(Comparator.comparingInt((BlockPos p)->p.getY()).thenComparingInt(p->p.getX()).thenComparingInt(p->p.getZ()));
            chosen.addAll(tree);
        }
        return new Tree(chosen.size()>MAX_LOGS?List.copyOf(chosen.subList(0,MAX_LOGS)):chosen,chosen.size()>MAX_LOGS);
    }
    /** The requested logs that belong to a tree with a crown, over the same cells nearest() looks at (a plain scan drops the rest). */
    static Set<BlockPos> wild(ServerLevel level,Vec3 center,int radius,ResourceCatalog.Selection selection) {
        List<Set<BlockPos>> pieces=pieces(region(level,center,radius,selection));int[] owner=attach(level,pieces);
        Set<Integer> crowned=crowned(level,pieces,owner);Set<BlockPos> wild=new HashSet<>();
        for(int i=0;i<pieces.size();i++)if(crowned.contains(owner[i]<0?i:owner[i]))wild.addAll(pieces.get(i));
        return wild;
    }
    /** Every requested log within radius+SPREAD across and BELOW below to ABOVE above the point, loaded chunks only. */
    private static Set<BlockPos> region(ServerLevel level,Vec3 center,int radius,ResourceCatalog.Selection selection) {
        BlockPos origin=BlockPos.containing(center);int reach=radius+SPREAD;
        Set<BlockPos> logs=new HashSet<>();
        for(int x=-reach;x<=reach;x++)for(int z=-reach;z<=reach;z++){
            if(x*x+z*z>reach*reach)continue;
            for(int y=-BELOW;y<=ABOVE;y++){BlockPos pos=origin.offset(x,y,z);BlockState state=loaded(level,pos);if(state!=null&&log(state,selection))logs.add(pos.immutable());}
        }
        return logs;
    }
    /** The roots (trunk or remnant pieces, see attach) whose tree has a crown: some log of it touches a crown block on a face. */
    private static Set<Integer> crowned(ServerLevel level,List<Set<BlockPos>> pieces,int[] owner) {
        Set<Integer> crowned=new HashSet<>();
        for(int i=0;i<pieces.size();i++){int root=owner[i]<0?i:owner[i];if(crowned.contains(root))continue;
            search:for(BlockPos p:pieces.get(i))for(Direction side:Direction.values()){BlockState next=loaded(level,p.relative(side));if(next!=null&&crown(next)){crowned.add(root);break search;}}}
        return crowned;
    }
    static boolean crown(BlockState state){return state.is(BlockTags.LEAVES)||state.is(BlockTags.WART_BLOCKS)||state.is(Blocks.SHROOMLIGHT);}
    private static boolean log(BlockState state,ResourceCatalog.Selection selection){return ResourceCatalog.kind(state)==ResourceCatalog.Kind.LOG&&selection.matches(state);}
    private static BlockState loaded(ServerLevel level,BlockPos pos) {
        if(level.isOutsideBuildHeight(pos)||!level.getWorldBorder().isWithinBounds(pos))return null;
        var chunk=level.getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
        return chunk==null?null:chunk.getBlockState(pos);
    }
    /** Logs connected through the 26-neighbourhood. */
    private static List<Set<BlockPos>> pieces(Set<BlockPos> logs) {
        List<Set<BlockPos>> pieces=new ArrayList<>();Set<BlockPos> seen=new HashSet<>();
        List<BlockPos> order=new ArrayList<>(logs);order.sort(Comparator.comparingInt((BlockPos p)->p.getY()).thenComparingInt(p->p.getX()).thenComparingInt(p->p.getZ()));
        for(BlockPos start:order){
            if(!seen.add(start))continue;
            Set<BlockPos> piece=new HashSet<>();Deque<BlockPos> queue=new ArrayDeque<>(List.of(start));
            while(!queue.isEmpty()){BlockPos at=queue.poll();piece.add(at);
                for(int dx=-1;dx<=1;dx++)for(int dy=-1;dy<=1;dy++)for(int dz=-1;dz<=1;dz++){BlockPos next=at.offset(dx,dy,dz);if(logs.contains(next)&&seen.add(next))queue.add(next);}}
            pieces.add(piece);
        }
        return pieces;
    }
    /** owner[i]: the trunk (or remnant) piece a piece belongs to; -1 for that trunk or remnant piece itself. */
    private static int[] attach(ServerLevel level,List<Set<BlockPos>> pieces) {
        int n=pieces.size();int[] owner=new int[n];Arrays.fill(owner,-1);boolean[] trunk=new boolean[n],tree=new boolean[n];
        for(int i=0;i<n;i++){trunk[i]=grounded(level,pieces.get(i));tree[i]=trunk[i];}
        // Nearest first, a branch may also hang on a branch already placed (a limb off a limb).
        for(boolean grew=true;grew;){
            grew=false;int bestPiece=-1,bestTo=-1,bestGap=Integer.MAX_VALUE;
            for(int i=0;i<n;i++){if(tree[i])continue;
                for(int j=0;j<n;j++){if(!tree[j])continue;int gap=gap(pieces.get(i),pieces.get(j));if(gap<bestGap){bestGap=gap;bestPiece=i;bestTo=j;}}}
            if(bestPiece>=0&&bestGap<=BRANCH_REACH){owner[bestPiece]=trunk[bestTo]?bestTo:owner[bestTo];tree[bestPiece]=true;grew=true;}
        }
        // Pieces that reach no trunk (the top half of a tree whose base was already cut, left hanging in the leaves):
        // those within BRANCH_REACH of one another are one remnant, cut as one tree.
        for(int i=0;i<n;i++){
            if(tree[i])continue;tree[i]=true;Deque<Integer> queue=new ArrayDeque<>(List.of(i));
            while(!queue.isEmpty()){int at=queue.poll();for(int j=0;j<n;j++)if(!tree[j]&&gap(pieces.get(at),pieces.get(j))<=BRANCH_REACH){tree[j]=true;owner[j]=i;queue.add(j);}}
        }
        return owner;
    }
    private static int gap(Set<BlockPos> a,Set<BlockPos> b) {
        int best=Integer.MAX_VALUE;
        for(BlockPos p:a)for(BlockPos q:b)best=Math.min(best,Math.max(Math.abs(p.getX()-q.getX()),Math.max(Math.abs(p.getY()-q.getY()),Math.abs(p.getZ()-q.getZ()))));
        return best;
    }
    private static boolean grounded(ServerLevel level,Set<BlockPos> piece) {
        for(BlockPos p:piece){
            BlockPos below=p.below();if(piece.contains(below))continue;
            BlockState state=loaded(level,below);
            if(state==null||state.isAir()||state.is(BlockTags.LOGS)||state.is(BlockTags.LEAVES))continue;
            if(state.is(Blocks.MANGROVE_ROOTS)||state.is(Blocks.MUDDY_MANGROVE_ROOTS)||state.isCollisionShapeFullBlock(level,below))return true;
        }
        return false;
    }
}
