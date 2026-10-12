package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.tags.BlockTags;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

final class NearbyResources {
    // Up to sixteen blocks around, two below and four above the centre: tree trunks and hillsides a walk away,
    // still never below the body's feet (ResourceCatalog.requireSafe). Matches are checked nearest first.
    static final int MAX_RADIUS=16,BELOW=2,ABOVE=4,MAX_VISITED=33*33*(BELOW+ABOVE+1);
    // Whole trees: logs connected to a log in the scan band are followed up to TREE_ABOVE above the centre
    // (at most TREE_LIMIT more), so gathering can climb a trunk for the rest. Leaves are never candidates.
    static final int TREE_ABOVE=24,TREE_LIMIT=64,TREE_SPREAD=4;
    record Options(Set<String> blockIds,int radius,int maxResults,Vec3 center,boolean wholeTree,int trees) {}
    static Options options(JsonObject args,Vec3 body) {
        var mining=args.has("companionMiningGuard")?CompanionMiningGuard.options(object(args,"companionMiningGuard")):null;
        if(mining!=null&&args.has("center"))throw error("INVALID_ARGUMENT","Companion mining scan center is always the live bound player position");
        if(!args.has("blockIds")||!args.get("blockIds").isJsonArray()||args.getAsJsonArray("blockIds").isEmpty()||args.getAsJsonArray("blockIds").size()>8)
            throw error("INVALID_ARGUMENT","blockIds requires one to eight block IDs or block tags");
        Set<String> ids=new LinkedHashSet<>();
        for(JsonElement entry:args.getAsJsonArray("blockIds")) {
            if(!entry.isJsonPrimitive()||!entry.getAsJsonPrimitive().isString()||!ResourceCatalog.selector(entry.getAsString())) throw error("INVALID_ARGUMENT","blockIds entries are block IDs (minecraft:oak_log) or block tags (#c:ores)");
            ids.add(entry.getAsString());
        }
        boolean wholeTree=args.has("wholeTree")&&args.get("wholeTree").isJsonPrimitive()&&args.get("wholeTree").getAsBoolean();
        if(wholeTree&&mining!=null)throw error("INVALID_ARGUMENT","wholeTree is not for companion mining");
        int radius=integer(args,"radius",mining==null?4:mining.maxDistance(),1,mining==null?MAX_RADIUS:mining.maxDistance()),limit=wholeTree?TreeScan.MAX_LOGS:integer(args,"maxResults",32,1,64);
        Vec3 center=body;
        if(args.has("center")) {JsonObject p=object(args,"center");center=new Vec3(number(p,"x"),number(p,"y"),number(p,"z"));}
        // A whole tree may be named by where it stands (a player's coordinates); gathering walks to it.
        if(center.distanceTo(body)>(wholeTree?16:8)) throw error("INVALID_ARGUMENT","Resource scan center must remain within eight blocks of the body (sixteen for a whole tree)");
        int trees=wholeTree?integer(args,"trees",1,1,8):1;
        return new Options(Set.copyOf(ids),radius,limit,center,wholeTree,trees);
    }
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {double value=bounded(args,key,fallback,min,max);if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");return (int)value;}
    record Candidate(BlockPos position,BlockState state,double distance) {}
    static JsonObject discover(ServerPlayer body,JsonObject args,ResourceTargets targets) {
        Options options=options(args,body.position());
        CompanionMiningGuard mining=args.has("companionMiningGuard")?CompanionMiningGuard.create(body,object(args,"companionMiningGuard")):null;
        if(mining!=null){mining.validateBody();options=new Options(options.blockIds(),options.radius(),options.maxResults(),mining.center(),false,1);}
        var selection=ResourceCatalog.select(options.blockIds());
        BlockPos origin=BlockPos.containing(options.center());
        List<Candidate> matches=new ArrayList<>(),found=new ArrayList<>();int visited=0,unloaded=0,rejected=0;boolean exhausted=false;
        FlatApproach geometry=new FlatApproach(body);
        TreeScan.Tree whole=options.wholeTree()?TreeScan.nearest(body.serverLevel(),options.center(),options.radius(),selection,options.trees()):null;
        if(whole!=null) for(BlockPos pos:whole.logs()) matches.add(new Candidate(pos,body.serverLevel().getBlockState(pos),Vec3.atCenterOf(pos).distanceTo(options.center())));
        else for(int x=-options.radius();x<=options.radius();x++) for(int z=-options.radius();z<=options.radius();z++) {
            if(x*x+z*z>options.radius()*options.radius())continue;
            for(int y=-BELOW;y<=ABOVE;y++) {
                visited++;BlockPos pos=origin.offset(x,y,z);
                if(body.serverLevel().isOutsideBuildHeight(pos)||!body.serverLevel().getWorldBorder().isWithinBounds(pos))continue;
                var chunk=body.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
                if(chunk==null){unloaded++;continue;}
                BlockState state=chunk.getBlockState(pos);
                // Companion mining digs ores only, whatever the request named.
                if(!selection.matches(state)||ResourceCatalog.kind(state)==null||mining!=null&&!ResourceCatalog.ore(state))continue;
                matches.add(new Candidate(pos,state,Vec3.atCenterOf(pos).distanceTo(options.center())));
            }
        }
        // Logs with no crown (a house wall, a fence) are no tree: a plain scan leaves them out, as a whole-tree one does (TreeScan).
        int builtLogs=0;
        if(whole==null&&mining==null&&matches.stream().anyMatch(c->ResourceCatalog.kind(c.state())==ResourceCatalog.Kind.LOG)){
            Set<BlockPos> wild=TreeScan.wild(body.serverLevel(),options.center(),options.radius(),selection);int before=matches.size();
            matches.removeIf(c->ResourceCatalog.kind(c.state())==ResourceCatalog.Kind.LOG&&!wild.contains(c.position()));builtLogs=before-matches.size();
        }
        if(whole==null) matches.sort(Comparator.comparingDouble(Candidate::distance).thenComparingInt(c->c.position().getX()).thenComparingInt(c->c.position().getY()).thenComparingInt(c->c.position().getZ()));
        Set<BlockPos> tree=new HashSet<>(mining==null&&whole==null?treeAbove(body,origin,options,selection,matches):Set.of());
        // Safety and line-of-sight checks cost terrain reads: run them nearest first, one past the limit to report truncation.
        List<Candidate> hidden=new ArrayList<>();
        for(Candidate match:matches) {
            if(found.size()>options.maxResults())break;
            // Logs high in a tree are usually hidden behind the trunk or leaves from the ground: dig time checks the real line of sight.
            try {if(mining!=null)mining.validateTarget(match.position());ResourceCatalog.requireSafe(body,match.position(),geometry,whole!=null);
                // A whole tree is asked for as a whole: logs hidden in its crown are marked unseen (dig time checks the real line of sight).
                if(whole!=null){if(!geometry.blockVisible(match.position()))tree.add(match.position());}
                else if(!tree.contains(match.position())&&!geometry.blockVisible(match.position())){
                    // A log seen only through leaves (a spruce wrapped in its crown) is a target too: gathering breaks the leaves first.
                    boolean log=mining==null&&ResourceCatalog.kind(match.state())==ResourceCatalog.Kind.LOG;
                    if(log&&geometry.blockVisibleThroughLeaves(match.position()))tree.add(match.position());
                    else {if(log)hidden.add(match);else rejected++;continue;}}}
            catch(Protocol.Error unsafe){if(unsafe.code.equals("PATH_BUDGET")){exhausted=true;break;}rejected++;continue;}
            found.add(match);
        }
        rejected+=trunk(found,hidden,tree,options.maxResults());
        JsonArray candidates=new JsonArray();
        var inventory=ToolAssessment.inventory(body);
        // Which tree each log belongs to: slanted trunks and branches past a gap in the leaves join their trunk (TreeScan).
        List<BlockPos> logPositions=new ArrayList<>();for(Candidate candidate:found)if(ResourceCatalog.kind(candidate.state())==ResourceCatalog.Kind.LOG)logPositions.add(candidate.position());
        Map<BlockPos,Integer> trees=TreeScan.group(body.serverLevel(),logPositions);
        // One loot-table profile per block type in this scan (same block, same drops).
        Map<BlockState,JsonArray> profiles=new HashMap<>();
        for(Candidate candidate:found.subList(0,Math.min(found.size(),options.maxResults()))) {
            JsonObject properties=new JsonObject();candidate.state().getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
            var tools=ToolAssessment.evaluateSummary(inventory,candidate.state(),candidate.state().getDestroySpeed(body.serverLevel(),candidate.position()));
            var kind=ResourceCatalog.kind(candidate.state());
            var policy=ResourceCatalog.discoveryPolicy(kind==ResourceCatalog.Kind.ORE);
            JsonArray drops=profiles.computeIfAbsent(candidate.state(),state->{JsonArray list=new JsonArray();for(var drop:ResourceCatalog.drops(body,candidate.position(),state))list.add(drop.json());return list;});
            JsonArray suitable=new JsonArray();for(var tool:tools)if(tool.slot()<9&&ToolAssessment.recommendationReason(tool,policy)==null)suitable.add(tool.slot());
            var recommended=ToolAssessment.recommend(tools,body.getInventory().selected,policy,true);
            var inventoryRecommended=ToolAssessment.recommend(tools,body.getInventory().selected,policy,false);
            JsonObject value=obj("position",position(Vec3.atLowerCornerOf(candidate.position())),"id",BuiltInRegistries.BLOCK.getKey(candidate.state().getBlock()).toString(),"properties",properties,
                "kind",kind.wire(),"drops",drops.deepCopy(),
                "targetToken",targets.issue(body,candidate.position(),candidate.state(),mining),"distance",candidate.distance(),"visible",!tree.contains(candidate.position()),"requiresCorrectTool",candidate.state().requiresCorrectToolForDrops(),"suitableToolSlots",suitable);
            if(trees.containsKey(candidate.position()))value.addProperty("tree",trees.get(candidate.position()));
            if(recommended!=null)value.addProperty("recommendedToolSlot",recommended.slot());
            if(inventoryRecommended!=null)value.addProperty("recommendedInventorySlot",inventoryRecommended.slot());
            candidates.add(value);
        }
        return obj("dimension",body.serverLevel().dimension().location().toString(),"center",position(options.center()),"candidates",candidates,
            "truncated",found.size()>options.maxResults()||exhausted||whole!=null&&whole.truncated(),"wholeTree",whole!=null,"budget",obj("radius",options.radius(),"below",BELOW,"above",ABOVE,"treeAbove",TREE_ABOVE,"treeLogs",tree.size(),"builtLogs",builtLogs,"matches",matches.size(),"visited",visited,"maxVisited",MAX_VISITED,"unloaded",unloaded,"rejected",rejected,"loadedOnly",true,"blockReads",geometry.reads(),"maxBlockReads",FlatApproach.MAX_READS));
    }
    /**
     * Logs above the scan band connected (26-neighbourhood) to a requested log found in it, appended to the
     * matches bottom-up. Only requested logs, loaded cells, within TREE_SPREAD of the scan radius.
     */
    private static Set<BlockPos> treeAbove(ServerPlayer body,BlockPos origin,Options options,ResourceCatalog.Selection selection,List<Candidate> matches) {
        Set<BlockPos> seen=new HashSet<>(),added=new LinkedHashSet<>();
        Deque<BlockPos> queue=new ArrayDeque<>();
        for(Candidate match:matches) {seen.add(match.position());if(ResourceCatalog.kind(match.state())==ResourceCatalog.Kind.LOG)queue.add(match.position());}
        int spread=options.radius()+TREE_SPREAD;
        List<Candidate> extra=new ArrayList<>();
        while(!queue.isEmpty()&&added.size()<TREE_LIMIT) {
            BlockPos from=queue.poll();
            for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) for(int dz=-1;dz<=1;dz++) {
                BlockPos next=from.offset(dx,dy,dz);
                if(!seen.add(next)||next.getY()<=origin.getY()+ABOVE&&dy<=0||next.getY()>origin.getY()+TREE_ABOVE)continue;
                int hx=next.getX()-origin.getX(),hz=next.getZ()-origin.getZ();
                if(hx*hx+hz*hz>spread*spread||body.serverLevel().isOutsideBuildHeight(next))continue;
                var chunk=body.serverLevel().getChunkSource().getChunkNow(next.getX()>>4,next.getZ()>>4);
                if(chunk==null)continue;
                BlockState state=chunk.getBlockState(next);
                if(ResourceCatalog.kind(state)!=ResourceCatalog.Kind.LOG||!selection.matches(state))continue;
                queue.add(next);
                if(next.getY()>origin.getY()+ABOVE&&added.size()<TREE_LIMIT){added.add(next);extra.add(new Candidate(next,state,Vec3.atCenterOf(next).distanceTo(options.center())));}
            }
        }
        extra.sort(Comparator.comparingInt((Candidate c)->c.position().getY()).thenComparingDouble(Candidate::distance));
        matches.addAll(extra);
        return added;
    }
    /**
     * Hidden logs in the scan band that belong to a tree already found (connected through logs to an accepted
     * candidate, 26-neighbourhood) join it: dense leaves (spruce) hide the middle of a trunk from the ground.
     * They are marked like the logs above the band (not visible; dig time checks the line of sight). Returns
     * how many hidden logs stay rejected.
     */
    static int trunk(List<Candidate> found,List<Candidate> hidden,Set<BlockPos> tree,int limit) {
        Set<BlockPos> joined=new HashSet<>();for(Candidate candidate:found)if(candidate.state().is(BlockTags.LOGS))joined.add(candidate.position());
        List<Candidate> left=new ArrayList<>(hidden);boolean grew=true;
        while(grew&&!left.isEmpty()) {
            grew=false;
            for(var it=left.iterator();it.hasNext();) {
                Candidate next=it.next();
                if(!touches(next.position(),joined))continue;
                it.remove();grew=true;joined.add(next.position());tree.add(next.position());
                if(found.size()<=limit)found.add(next);
            }
        }
        return left.size();
    }
    private static boolean touches(BlockPos p,Set<BlockPos> set) {
        for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) for(int dz=-1;dz<=1;dz++) if((dx|dy|dz)!=0&&set.contains(p.offset(dx,dy,dz)))return true;
        return false;
    }
    private static JsonObject position(Vec3 p){return obj("x",p.x,"y",p.y,"z",p.z);}
}
