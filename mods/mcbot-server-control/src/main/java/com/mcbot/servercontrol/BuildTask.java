package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.mixin.BlockItemInvoker;
import com.mcbot.servercontrol.mixin.ServerPlayerGameModeAccessor;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.*;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.DamageTypeTags;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.*;
import net.minecraft.world.item.context.BlockPlaceContext;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BedPart;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.phys.*;
import net.minecraft.world.phys.shapes.CollisionContext;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * build: put a list of block states into the world like a player. Each position is compared with the world first:
 * already right is left alone, wrong or in the way is dug (top down) when `replace` allows, then blocks go in bottom up,
 * layer by layer, with attached things (doors, torches, lanterns, carpets, plants...) after the layer they hang on.
 * A block is placed with the ordinary right-click: before clicking, the click is tried in the game's own placement code
 * (the item's getPlacementState for this face, spot on the face and way of looking) from where the body could stand,
 * and only a click that gives the wanted state (facing, half, axis, hinge...) is used; afterwards the state is checked.
 * Properties the neighbours decide (stair corners, fence connections, waterlogging...) are not compared. The body
 * clicks while sneaking, so a chest or door it builds against is never opened. It walks to a spot within reach
 * (never inside a block still to be placed); out of reach it pillars up on spare blocks, clicks against a
 * temporary block where a spot has nothing to click on, steps onto floors it built, and digs all of that back afterwards.
 * It builds no scaffold corridors: what still cannot be reached is reported.
 * Materials come from the inventory (plain stacks); missing ones fail the build before anything changes.
 */
final class BuildTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,false,"Build task fault",false);}
    record Target(BlockPos pos,BlockState state,List<Property<?>> checked,Item item,BlockPos extra,boolean late) {
        boolean air(){return state.isAir();}
    }
    record Click(BlockHitResult hit,float yaw,float pitch) {}
    static final int MAX_CELLS=4096,MAX_DISTANCE=48,WALK_MS=15_000,STALL_MS=4_000,SPOT_RADIUS=5,MAX_SPOTS=240;
    /** Decided by neighbours or by use, not by the placing click: never compared. */
    static final Set<String> AUTO=Set.of("waterlogged","shape","north","south","east","west","up","powered","occupied","open","in_wall","snowy",
        "distance","persistent","extended","enabled","triggered","lit","attached","disarmed","conditional","signal_fire","has_book","has_record","bottom",
        "leaves","stage","age","level","power","note","instrument","moisture","honey_level","hatch","eggs","pickles","candles","layers","bites","rotation",
        "mode","inverted","locked","delay","tilt");
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final String replace;
    private final Map<String,Integer> before;
    private final List<Target> targets=new ArrayList<>();
    private final List<BlockPos> digs=new ArrayList<>();
    private final List<Target> places=new ArrayList<>();
    private final Set<BlockPos> pendingCells=new HashSet<>(),targetCells=new HashSet<>();
    private float health;
    private int falls;
    private final Set<Target> waiting=new HashSet<>();
    private final JsonArray skipped=new JsonArray(),wrong=new JsonArray();
    private final Map<String,Integer> skippedWhy=new TreeMap<>();
    private int already,placed,dug,skippedCount,sequence,cooldown;
    // walking
    private NativeNavigation navigation;
    private Object walkingTo;
    private Vec3 spot;
    private long walkStarted,stallSince;
    private Vec3 stallAt;
    // breaking a block that takes time
    private BlockPos digging;
    private BlockState digState;
    private Direction digFace;
    private long digDeadline;

    BuildTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;
        JsonObject args=operation.args;
        replace=args.has("replace")?string(args,"replace"):"soft";
        if(!Set.of("none","soft","all").contains(replace))throw error("INVALID_ARGUMENT","replace must be none, soft or all");
        long timeout=(long)bounded(args,"timeoutMs",240_000,10_000,600_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);
        before=ItemDescriptions.counts(player.getInventory());health=player.getHealth();
        parse(args);
        for(Target t:targets){targetCells.add(t.pos());if(t.extra()!=null)targetCells.add(t.extra());}
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private ServerLevel level(){return player.serverLevel();}

    // ---------- targets ----------
    private void parse(JsonObject args) {
        if(!args.has("blocks")||!args.get("blocks").isJsonArray())throw error("INVALID_ARGUMENT","blocks must be an array");
        JsonArray blocks=args.getAsJsonArray("blocks");
        if(blocks.isEmpty()||blocks.size()>MAX_CELLS)throw error("INVALID_ARGUMENT","blocks must list 1-"+MAX_CELLS+" cells");
        Map<BlockPos,Target> map=new LinkedHashMap<>();List<BlockPos> companions=new ArrayList<>();
        for(JsonElement element:blocks) {
            if(!element.isJsonObject())throw error("INVALID_ARGUMENT","Each block must be an object");
            JsonObject cell=element.getAsJsonObject();
            BlockPos pos=BlockPos.containing(number(cell,"x"),number(cell,"y"),number(cell,"z"));
            if(Math.hypot(pos.getX()+0.5-player.getX(),pos.getZ()+0.5-player.getZ())>MAX_DISTANCE)throw error("OUT_OF_REACH","Every block must be within "+MAX_DISTANCE+" blocks of the body");
            if(!level().isInWorldBounds(pos))throw error("INVALID_ARGUMENT","Outside the world height: "+pos.toShortString());
            String text=string(cell,"state");
            BlockStateParser.BlockResult parsed;
            try{parsed=BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK.asLookup(),text,false);}
            catch(com.mojang.brigadier.exceptions.CommandSyntaxException e){throw error("INVALID_ARGUMENT","Bad block state "+text+": "+e.getRawMessage().getString());}
            double turn=cell.has("rotation")?number(cell,"rotation"):0;
            Rotation rotation=switch((int)turn){case 0->Rotation.NONE;case 90->Rotation.CLOCKWISE_90;case 180->Rotation.CLOCKWISE_180;case 270->Rotation.COUNTERCLOCKWISE_90;default->throw error("INVALID_ARGUMENT","rotation must be 0, 90, 180 or 270");};
            if(turn!=Math.rint(turn))throw error("INVALID_ARGUMENT","rotation must be 0, 90, 180 or 270");
            BlockState state=parsed.blockState().rotate(rotation);
            if(!state.getFluidState().isEmpty()&&!state.hasProperty(BlockStateProperties.WATERLOGGED))throw error("UNSUPPORTED",text+" is a fluid; pour it with use-bucket");
            if(state.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF)&&state.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF)==DoubleBlockHalf.UPPER
                ||state.hasProperty(BlockStateProperties.BED_PART)&&state.getValue(BlockStateProperties.BED_PART)==BedPart.HEAD){companions.add(pos);map.remove(pos);continue;}
            Item item=state.isAir()?Items.AIR:state.getBlock().asItem();
            if(!state.isAir()&&item==Items.AIR)throw error("UNSUPPORTED",text+" has no item to place it with");
            if(state.hasProperty(BlockStateProperties.SLAB_TYPE)&&state.getValue(BlockStateProperties.SLAB_TYPE)==SlabType.DOUBLE)throw error("UNSUPPORTED","Double slabs are not placed yet; use the full block at "+pos.toShortString());
            List<Property<?>> checked=new ArrayList<>();
            for(Property<?> property:parsed.properties().keySet())if(!AUTO.contains(property.getName()))checked.add(property);
            BlockPos extra=null;
            if(state.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF))extra=pos.above();
            else if(state.getBlock() instanceof BedBlock)extra=pos.relative(state.getValue(BedBlock.FACING));
            map.put(pos,new Target(pos,state,checked,item,extra,!state.isAir()&&late(state.getBlock())));
        }
        for(BlockPos c:companions)if(map.values().stream().noneMatch(t->c.equals(t.extra())))
            throw error("INVALID_ARGUMENT","The upper half of a door or plant, or the head of a bed, comes with its other half: give the lower half (half=lower) or the foot (part=foot) instead, at "+c.toShortString());
        for(Target t:List.copyOf(map.values()))if(t.extra()!=null&&!t.air()) {
            Target other=map.get(t.extra());
            if(other!=null&&!other.air())throw error("INVALID_ARGUMENT",t.pos().toShortString()+" also takes "+t.extra().toShortString()+", where another block is given");
            map.remove(t.extra());
        }
        targets.addAll(map.values());
    }
    /** Hung on, stood on or attached to a neighbour: placed after the layer it belongs to. */
    static boolean late(Block block) {
        return block instanceof DoorBlock||block instanceof BedBlock||block instanceof BaseTorchBlock||block instanceof LadderBlock||block instanceof TrapDoorBlock
            ||block instanceof ButtonBlock||block instanceof LeverBlock||block instanceof LanternBlock||block instanceof SignBlock||block instanceof AbstractBannerBlock
            ||block instanceof CarpetBlock||block instanceof BasePressurePlateBlock||block instanceof BaseRailBlock||block instanceof FlowerPotBlock||block instanceof CandleBlock
            ||block instanceof ChainBlock||block instanceof AbstractSkullBlock||block instanceof BellBlock||block instanceof ScaffoldingBlock||block instanceof TripWireHookBlock
            ||block instanceof BushBlock;
    }
    static boolean matches(BlockState actual,Target t) {
        if(t.air())return actual.isAir();
        if(!actual.is(t.state().getBlock()))return false;
        for(Property<?> property:t.checked())if(!actual.getValue(property).equals(t.state().getValue(property)))return false;
        return true;
    }
    private static String text(BlockState state){return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();}

    // ---------- the plan ----------
    private void skip(BlockPos pos,BlockState wanted,String why) {
        skippedCount++;skippedWhy.merge(why,1,Integer::sum);
        if(skipped.size()<12)skipped.add(obj("at",pos(pos),"block",text(wanted),"why",why));
    }
    /** May this block be dug out of the way? Never a fluid or anything holding contents (chests, furnaces, signs...). */
    private String undiggable(BlockPos pos) {
        BlockState state=level().getBlockState(pos);
        if(!state.getFluidState().isEmpty()&&state.getBlock() instanceof LiquidBlock)return "liquid in the way";
        if(level().getBlockEntity(pos)!=null)return "a block holding contents is in the way";
        if(state.getDestroySpeed(level(),pos)<0)return "unbreakable block in the way";
        return null;
    }
    /** Something there that a placement simply replaces: air, or grass, flowers, snow with nothing to dig. */
    private boolean free(BlockPos pos) {
        BlockState state=level().getBlockState(pos);
        return state.isAir()||state.canBeReplaced()&&state.getFluidState().isEmpty()&&state.getShape(level(),pos).isEmpty();
    }
    private boolean soft(BlockState state){return state.canBeReplaced()&&state.getFluidState().isEmpty();}
    /** What has to go first so `pos` can take a block: null when nothing, or why it cannot. */
    private String clear(BlockPos pos,Target t,List<BlockPos> out,boolean ownHalf) {
        if(free(pos)||ownHalf)return null;
        BlockState current=level().getBlockState(pos);
        boolean sameWrong=current.is(t.state().getBlock());
        if(!soft(current)&&!(sameWrong&&!replace.equals("none"))&&!replace.equals("all"))return replace.equals("none")?"occupied (replace none)":"occupied by "+text(current)+" (replace all digs it)";
        String why=undiggable(pos);if(why!=null)return why;
        out.add(pos);return null;
    }
    private void classify() {
        for(Target t:targets) {
            if(!level().isLoaded(t.pos())||t.extra()!=null&&!level().isLoaded(t.extra())){skip(t.pos(),t.state(),"chunk not loaded");continue;}
            BlockState current=level().getBlockState(t.pos());
            if(matches(current,t)){already++;continue;}
            if(t.air()) {
                String why=undiggable(t.pos());
                if(why!=null){skip(t.pos(),t.state(),why);continue;}
                digs.add(t.pos());continue;
            }
            List<BlockPos> cleared=new ArrayList<>();
            String why=clear(t.pos(),t,cleared,false);
            // The other half of a door or bed being redone goes with it.
            if(why==null&&t.extra()!=null)why=clear(t.extra(),t,cleared,level().getBlockState(t.extra()).is(t.state().getBlock())&&cleared.contains(t.pos()));
            if(why!=null){skip(t.pos(),t.state(),why);continue;}
            digs.addAll(cleared);places.add(t);pendingCells.add(t.pos());if(t.extra()!=null)pendingCells.add(t.extra());
        }
    }
    /** Items still to place, by item, against plain stacks in the inventory. */
    private JsonArray materials(boolean onlyMissing) {
        Map<Item,Integer> need=new LinkedHashMap<>();
        for(Target t:places)need.merge(t.item(),1,Integer::sum);
        JsonArray out=new JsonArray();
        for(var e:need.entrySet()){int have=plainCount(e.getKey());if(!onlyMissing||have<e.getValue())out.add(obj("item",id(e.getKey()),"need",e.getValue(),"have",have));}
        return out;
    }
    private int plainCount(Item item){Inventory inv=player.getInventory();int n=0;for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.is(item))n+=s.getCount();}return n;}
    /** dryRun: what the build would do now, touching nothing. */
    JsonObject plan() {
        classify();
        return obj("cells",targets.size(),"already",already,"toPlace",places.size(),"toDig",digs.size(),"materials",materials(false),"missing",materials(true),
            "skippedCount",skippedCount,"skipped",skipped,"skippedWhy",skippedWhy);
    }
    void start() {
        classify();
        JsonArray missing=materials(true);
        if(!missing.isEmpty()){JsonObject r=progress();r.addProperty("code","MISSING_MATERIALS");r.add("missing",missing);operation.finish("failed","MISSING_MATERIALS: the inventory lacks blocks for this build; nothing was changed",r);return;}
        digs.sort(Comparator.comparingInt((BlockPos p)->-p.getY()));
        if(digs.isEmpty()&&places.isEmpty())finish(null);
    }

    // ---------- the loop ----------
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(now()>=deadline) {
            // On a scaffold, or up on a roof stepped onto from one, when time runs out: a little longer to come down and dig
            // it back, so no pillar of dirt is left standing.
            boolean onColumn=!scaffold.isEmpty()&&(mode==Mode.UP||mode==Mode.RISING||mode==Mode.DESCENDING)||mode==Mode.COLLECT;
            if(now()>=deadline+60_000||!onColumn&&leftColumns.isEmpty()){finish("TIMEOUT");return;}
            if(!wrappingUp){wrappingUp=true;note("time is up: "+mode+", on a scaffold of "+scaffold.size()+", "+leftColumns.size()+" left behind");}
            if(mode==Mode.UP||mode==Mode.RISING){player.stopInput();mode=Mode.DESCENDING;}
            else if(mode==Mode.TO_COLUMN){stopWalking();column=null;columnFor=null;mode=Mode.GROUND;}
            if(mode==Mode.GROUND){if(digging!=null)tickDig();else if(cooldown>0)cooldown--;else if(!returnToColumn())finish("TIMEOUT");return;}
        }
        if(player.getHealth()<health){var source=player.getLastDamageSource();
            // A short fall off a half-built floor, as players take while building: noted, and the walk planned again from where it landed.
            if(source!=null&&source.is(DamageTypeTags.IS_FALL)&&player.getHealth()>=player.getMaxHealth()/2){note(String.format("fell (%.0f damage)",health-player.getHealth()));stopWalking();falls++;}
            else throw error("BLOCKED","Body took damage while building"+(source!=null?" ("+source.getMsgId()+")":""));}
        health=player.getHealth();
        if(digging!=null){tickDig();return;}
        if(cooldown>0){cooldown--;return;}
        switch(mode){case TO_COLUMN->{walkToColumn();return;}case RISING->{rise();return;}case DESCENDING->{descend();return;}case COLLECT->{collect();return;}case STEPPING->{step();return;}default->{}}
        Vec3 feet=player.position();
        if(mode==Mode.GROUND&&!digs.isEmpty()) {
            digs.removeIf(p->level().getBlockState(p).isAir());
            if(!digs.isEmpty()) {
                // Highest first; among the highest, one in reach from here, else the nearest.
                int top=digs.stream().mapToInt(BlockPos::getY).max().getAsInt();
                BlockPos next=null;double best=Double.MAX_VALUE;
                for(BlockPos p:digs)if(p.getY()==top){double d=Vec3.atCenterOf(p).distanceToSqr(feet);if(player.onGround()&&hitFrom(feet,p,null)!=null){next=p;break;}if(d<best){best=d;next=p;}}
                BlockHitResult hit=player.onGround()?hitFrom(feet,next,null):null;
                if(hit==null){BlockPos target=next;walkTo(next,f->hitFrom(f,target,null)!=null);return;}
                stopWalking();player.stopInput();dig(next,hit);cooldown=1;return;
            }
        }
        places.removeIf(t->{if(matches(level().getBlockState(t.pos()),t)){done(t);return true;}return false;});
        if(mode==Mode.UP) {
            // Up on the scaffold: what is to be dug and in reach first (top down), then everything placeable, lowest layer first.
            if(player.onGround()){BlockPos dig=null;for(BlockPos p:digs)if((dig==null||p.getY()>dig.getY())&&hitFrom(feet,p,null)!=null)dig=p;
                if(dig!=null){player.stopInput();dig(dig,hitFrom(feet,dig,null));cooldown=1;return;}}
            Target best=null;Click bestClick=null;int bestKey=Integer.MAX_VALUE;double bestDistance=Double.MAX_VALUE;
            if(player.onGround())for(Target t:places){int key=key(t);double d=Vec3.atCenterOf(t.pos()).distanceToSqr(feet);
                if(key>bestKey||key==bestKey&&d>=bestDistance)continue;Click c=clickFrom(feet,t);if(c!=null){best=t;bestClick=c;bestKey=key;bestDistance=d;}}
            if(best!=null){player.stopInput();place(best,bestClick);cooldown=1;return;}
            if(stepOff())return;
            if(columnFor instanceof Target ct&&places.contains(ct)){waiting.add(ct);whyWaiting.putIfAbsent(ct,"not placeable even from a scaffold");}
            if(columnFor instanceof BlockPos cp&&digs.contains(cp))failDig(cp,"not reachable even from a scaffold");
            note("down from "+scaffold.size());mode=Mode.DESCENDING;return;
        }
        if(goBack){if(!returnToColumn())goBack=false;return;}
        if(places.isEmpty()){if(!returnToColumn())finish(null);return;}
        // The lowest layer first, attached blocks after the plain ones; a block with nothing to click on yet waits.
        Target first=frontier();
        if(first==null){if(!returnToColumn())finish(null);return;}
        Click click=player.onGround()&&!overlaps(feet)?clickFrom(feet,first):null;
        if(click!=null){stopWalking();player.stopInput();place(first,click);cooldown=1;return;}
        // Keep walking to the block it set out for (two equally near ones would otherwise take turns every step).
        Target t=walkingTo instanceof Target w&&places.contains(w)&&!waiting.contains(w)&&key(w)==key(first)?w:first;
        walkTo(t,f->!overlaps(f)&&clickFrom(f,t)!=null);
    }
    private static int key(Target t){return (t.late()?1:0)*100_000+t.pos().getY();}

    // ---------- scaffold: a column of spare blocks to stand on for what the ground cannot reach ----------
    private enum Mode { GROUND,TO_COLUMN,RISING,UP,DESCENDING,COLLECT,STEPPING }
    static final int MAX_SCAFFOLD=8;
    private Mode mode=Mode.GROUND;
    private BlockPos column;
    private int columnHeight,riseTries,scaffoldUsed;
    private Item scaffoldItem;
    private Object columnFor;
    private final Map<Object,Integer> columnTries=new HashMap<>();
    /** Climbs onto each roof spot: kept when stepping off (unlike columnTries), so a spot that leads nowhere is not climbed for ever. */
    private final Map<BlockPos,Integer> climbTries=new HashMap<>();
    private final List<BlockPos> scaffold=new ArrayList<>();
    private boolean leftGround,risePlaced;
    private long stepDeadline;
    /** A spare plain full block to stand on: not needed by the build, breakable by hand or a carried tool, softest first. */
    private Item scaffoldItem(int count) {
        Map<Item,Integer> need=new HashMap<>();for(Target t:places)need.merge(t.item(),1,Integer::sum);
        Item best=null;float hardness=Float.MAX_VALUE;Inventory inv=player.getInventory();
        for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);
            if(!plain(s)||!(s.getItem() instanceof BlockItem b)||!NativePillar.pillarBlock(b.getBlock(),level(),player.blockPosition()))continue;
            BlockState state=b.getBlock().defaultBlockState();
            if(state.requiresCorrectToolForDrops()&&!hasToolFor(state))continue;
            if(plainCount(s.getItem())-need.getOrDefault(s.getItem(),0)<count)continue;
            float h=state.getDestroySpeed(level(),player.blockPosition());if(h>=0&&h<hardness){hardness=h;best=s.getItem();}}
        return best;
    }
    private boolean hasToolFor(BlockState state){Inventory inv=player.getInventory();for(int i=0;i<36;i++)if(inv.getItem(i).isCorrectToolForDrops(state))return true;return false;}
    private boolean emptyCell(BlockPos p){
        if(pendingCells.contains(p)||targetCells.contains(p))return false;
        BlockState s=level().getBlockState(p);return (s.isAir()||s.canBeReplaced())&&s.getFluidState().isEmpty()&&s.getCollisionShape(level(),p).isEmpty();
    }
    /** The lowest column near `t` (ground spot, free cells up to the head) from whose top `t` can be clicked; sets column, height and item. */
    private boolean planColumn(Target t){return planColumn(t.pos(),f->!overlaps(f)&&clickFrom(f,t)!=null,t);}
    private boolean planColumn(BlockPos near,Predicate<Vec3> reach,Object work) {
        List<BlockPos> bases=new ArrayList<>();
        for(int dx=-4;dx<=4;dx++)for(int dz=-4;dz<=4;dz++)for(int dy=-MAX_SCAFFOLD-1;dy<=0;dy++){BlockPos c=near.offset(dx,dy,dz);if(unreachableSpots.contains(c))continue;Vec3 f=standable(c);if(f!=null&&Math.abs(f.y-c.getY())<1e-6&&emptyCell(c))bases.add(c);}
        // Bases on the floor the body stands on first (up on the first floor, the stairs down may be far or not built
        // yet), then the lowest (the ground), then the nearest; the lowest column there.
        Vec3 from=player.position();int level=player.blockPosition().getY();
        bases.sort(Comparator.comparingInt((BlockPos c)->Math.abs(c.getY()-level)<=1?0:1).thenComparingInt(c->c.getY()).thenComparingDouble(c->Vec3.atBottomCenterOf(c).distanceToSqr(from)));
        Item item=scaffoldItem(1);if(item==null){if(work instanceof Target t)whyWaiting.putIfAbsent(t,"too high to reach and no spare blocks (dirt, planks...) to stand on");return false;}
        int tried=0;
        for(BlockPos c:bases) {
            if(++tried>120)break;
            for(int h=1;h<=MAX_SCAFFOLD;h++) {
                if(!emptyCell(c.above(h))||!emptyCell(c.above(h+1)))break;
                Vec3 top=Vec3.atBottomCenterOf(c.above(h));
                if(!reach.test(top))continue;
                Item spare=scaffoldItem(h);if(spare==null)break;
                column=c;columnHeight=h;scaffoldItem=spare;columnFor=work;return true;
            }
        }
        return false;
    }
    private void walkToColumn() {
        Vec3 base=Vec3.atBottomCenterOf(column);
        if(player.onGround()&&player.blockPosition().equals(column)&&Math.hypot(player.getX()-base.x,player.getZ()-base.z)<0.3){stopWalking();player.stopInput();mode=Mode.RISING;riseTries=0;leftGround=false;risePlaced=false;placedUp=0;stepDeadline=now()+3000;return;}
        walkTo(column,f->BlockPos.containing(f).equals(column)&&Math.hypot(f.x-base.x,f.z-base.z)<0.3);
    }
    /** Jump in place and put a spare block under the feet once they clear the cell, as a player pillars up; level by level. */
    private void rise() {
        int level=scaffold.size();
        if(level>=columnHeight&&player.onGround()){player.stopInput();mode=Mode.UP;return;}
        if(now()>stepDeadline){player.stopInput();if(++riseTries>2){mode=Mode.DESCENDING;if(columnFor instanceof Target ct){waiting.add(ct);whyWaiting.putIfAbsent(ct,"could not pillar up");}else if(columnFor instanceof BlockPos cp&&digs.contains(cp))failDig(cp,"could not pillar up");return;}leftGround=false;risePlaced=false;stepDeadline=now()+3000;return;}
        BlockPos cell=column.above(level);
        if(risePlaced){player.jumpInput(false);if(player.onGround()){scaffold.add(cell);scaffoldUsed++;risePlaced=false;leftGround=false;stepDeadline=now()+3000;}return;}
        if(!hold(s->plain(s)&&s.is(scaffoldItem))){mode=Mode.DESCENDING;return;}
        player.setXRot(90);
        if(player.onGround()&&!leftGround){if(!emptyCell(cell.above())||!emptyCell(cell.above(2))){mode=Mode.DESCENDING;return;}player.jumpInput(true);return;}
        if(!player.onGround())leftGround=true;
        player.jumpInput(false);
        if(leftGround&&player.onGround()){leftGround=false;return;} // landed without placing: jump again
        if(player.getY()<cell.getY()+1.0)return;
        int had=plainCount(scaffoldItem);
        BlockHitResult hit=new BlockHitResult(new Vec3(cell.getX()+0.5,cell.getY(),cell.getZ()+0.5),Direction.UP,cell.below(),false);
        boolean sneaking=player.isShiftKeyDown();player.setShiftKeyDown(true);
        try{player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));}finally{player.setShiftKeyDown(sneaking);}
        if(level().getBlockState(cell).is(((BlockItem)scaffoldItem).getBlock())&&plainCount(scaffoldItem)==had-1)risePlaced=true;
        else if(plainCount(scaffoldItem)!=had)throw error("UNKNOWN","A scaffold block was used but did not appear at "+cell.toShortString());
    }
    /** Dig the scaffold back from the top while standing on it; the drops land where the body is. */
    private void descend() {
        climbing=false;
        scaffold.removeIf(p->!level().getBlockState(p).is(((BlockItem)scaffoldItem).getBlock()));
        if(scaffold.isEmpty()){mode=Mode.COLLECT;collectUntil=now()+8000;return;}
        if(!player.onGround())return;
        BlockPos top=scaffold.getLast();
        if(!player.blockPosition().below().equals(top)){abandonScaffold();return;} // pushed off
        BlockHitResult hit=hitFrom(player.position(),top,Direction.UP);
        if(hit==null){abandonScaffold();return;}
        scaffoldDig=true;dig(top,hit);
    }
    /**
     * Off the column with blocks of it still standing: they are dug out later like a helper, and the next column starts
     * from nothing (a stale count made the next one think it was already up, while still on the ground).
     */
    /** A column stepped off onto a floor or roof, with the block it is made of: dug back from its top once the work up there is done. */
    private record Left(List<BlockPos> cells,Item item) {}
    private final List<Left> leftColumns=new ArrayList<>();
    private BlockPos returning;
    private boolean wrappingUp,goBack;
    /** The column being built is for climbing onto a roof or floor, not for reaching a block: step off it even with nothing placed. */
    private boolean climbing;
    /** Blocks of columns that could not be come down: dug from below like a helper, reported as left while they stand. */
    private final Set<BlockPos> columnDigs=new HashSet<>();
    /** Blocks placed from the column the body is up on now: stepping off one that reached nothing goes nowhere. */
    private int placedUp;
    /**
     * Up on a column with nothing more in reach, beside a floor or roof already built at this height, and work left up
     * here: step over onto it, as a player climbs onto the eaves and goes on from the roof, instead of coming down.
     */
    private boolean stepOff() {
        if(!player.onGround()||scaffold.isEmpty()||placedUp==0&&!climbing)return false;
        int y=player.blockPosition().getY();
        if(places.stream().noneMatch(t->t.pos().getY()>=y-1))return false;
        for(Direction d:Direction.Plane.HORIZONTAL)for(int up=0;up<=2;up++) {
            BlockPos next=player.blockPosition().relative(d).above(up);
            if(scaffold.contains(next.below())||pendingCells.contains(next))continue;
            Vec3 f=standable(next);
            if(f==null)continue;
            double climb=f.y-player.getY();
            if(climb<-0.6||climb>2.6)continue;
            if(climb>1.2) {
                // The eaves a block or two above the top: up one or two more first, then over (a body steps up 1.2 at most).
                int more=(int)Math.ceil(climb-1.2);
                if(scaffold.size()+more>MAX_SCAFFOLD||!emptyCell(column.above(scaffold.size()+more))||!emptyCell(column.above(scaffold.size()+more+1)))continue;
                columnHeight=scaffold.size()+more;mode=Mode.RISING;riseTries=0;leftGround=false;risePlaced=false;stepDeadline=now()+3000;
                note("up "+more+" more to step onto "+next.toShortString());return true;
            }
            leftColumns.add(new Left(new ArrayList<>(scaffold),scaffoldItem));
            note("stepped off a scaffold of "+scaffold.size()+" onto "+next.toShortString());climbing=false;
            scaffold.clear();column=null;columnFor=null;unreachableSpots.clear();columnTries.clear();
            // One step over by hand: the route planner may not find the step from a pillar top onto a slab roof.
            mode=Mode.STEPPING;stepTo=f;stepUntil=now()+2000;
            return true;
        }
        return false;
    }
    private Vec3 stepTo;
    private long stepUntil;
    /** Walk straight onto the spot beside the column top, jumping if it is higher; then on as on the ground. */
    private void step() {
        Vec3 at=player.position(),d=stepTo.subtract(at);
        if(player.onGround()&&d.horizontalDistance()<0.3&&Math.abs(d.y)<0.6||now()>stepUntil){player.stopInput();if(now()>stepUntil)note("could not step over");mode=Mode.GROUND;return;}
        player.jumpInput(player.onGround()&&d.y>0.6);
        player.moveInput(d.x,d.z,(float)Math.min(1,d.horizontalDistance()/0.4));
    }
    /** The work up here is done: walk back onto the top of a column stepped off from and come down it. False when none is left. */
    private boolean returnToColumn() {
        leftColumns.removeIf(l->{l.cells().removeIf(p->!level().getBlockState(p).is(((BlockItem)l.item()).getBlock()));return l.cells().isEmpty();});
        if(leftColumns.isEmpty())return false;
        Left l=leftColumns.getFirst();BlockPos stand=l.cells().getLast().above();
        if(player.onGround()&&player.blockPosition().equals(stand)) {
            stopWalking();player.stopInput();returning=null;leftColumns.removeFirst();
            scaffold.clear();scaffold.addAll(l.cells());scaffoldItem=l.item();column=l.cells().getFirst();
            note("back on a scaffold: down from "+scaffold.size());mode=Mode.DESCENDING;return true;
        }
        if(!stand.equals(returning))returning=stand; // the same object every tick: walkTo tells a new walk by identity
        BlockPos to=returning;walkTo(to,f->BlockPos.containing(f).equals(to));
        return true;
    }
    private void abandonScaffold() {
        for(BlockPos p:scaffold)if(level().getBlockState(p).is(((BlockItem)scaffoldItem).getBlock())){helperDigs.add(p);columnDigs.add(p);if(!digs.contains(p))digs.add(p);}
        note("left the scaffold with "+scaffold.size()+" standing");
        scaffold.clear();mode=Mode.GROUND;column=null;columnFor=null;
    }
    private boolean scaffoldDig;
    private long collectUntil;
    private final Set<UUID> lostDrops=new HashSet<>();
    /** After coming down: pick up the scaffold blocks that bounced off the column, for a few seconds. */
    private void collect() {
        ItemEntity drop=null;double best=Double.MAX_VALUE;
        if(column!=null&&now()<collectUntil)for(ItemEntity e:level().getEntitiesOfClass(ItemEntity.class,new AABB(column).inflate(4,MAX_SCAFFOLD+2,4),e->e.isAlive()&&e.getItem().is(scaffoldItem)&&!lostDrops.contains(e.getUUID()))){double d=e.distanceToSqr(player);if(d<best){best=d;drop=e;}}
        if(drop==null){stopWalking();mode=Mode.GROUND;column=null;columnFor=null;return;}
        if(!drop.onGround()){player.stopInput();return;}
        FlatApproach geometry=new FlatApproach(player);ItemEntity target=drop;
        walkTo(target,f->geometry.itemReach(f,target.getBoundingBox()));
    }
    /** The last steps, for the result: what it did where, so a slow or stuck build can be read afterwards. */
    private final ArrayDeque<String> trace=new ArrayDeque<>();
    /** Floor spots the body could not walk to: not offered again. */
    private final Set<BlockPos> unreachableSpots=new HashSet<>();
    private long spotsForgotten;
    private final long began=now();
    private void note(String what){trace.addLast(String.format("%.1fs %s",(now()-began)/1000.0,what));while(trace.size()>60)trace.removeFirst();}
    /** Nearest target of the lowest pending layer that is not waiting for a neighbour; a layer that is all waiting is given up. */
    private Target frontier() {
        while(true) {
            Target best=null;int bestKey=Integer.MAX_VALUE;double bestDistance=Double.MAX_VALUE;
            for(Target t:places){int key=(t.late()?1:0)*100_000+t.pos().getY();if(key<bestKey){bestKey=key;}}
            if(bestKey==Integer.MAX_VALUE)return null;
            List<Target> layer=new ArrayList<>();for(Target t:places)if((t.late()?1:0)*100_000+t.pos().getY()==bestKey)layer.add(t);
            Vec3 feet=player.position();
            for(Target t:layer){if(waiting.contains(t))continue;double d=Vec3.atCenterOf(t.pos()).distanceToSqr(feet);if(d<bestDistance){bestDistance=d;best=t;}}
            if(best!=null)return best;
            // Nothing in this layer can be placed from anywhere now: a temporary block beside one of them may give it
            // something to click on; failing that, report the layer and go on with the next one.
            boolean helped=false;
            // One at a time: two helpers could each sit in the cell the other target needs.
            if(helperOf.isEmpty())for(Target t:layer)if(!helpers.contains(t)&&helper(t)){helped=true;break;}
            if(helped){waiting.removeAll(layer);continue;}
            for(Target t:layer){if(!helpers.contains(t))skip(t.pos(),t.state(),whyWaiting.getOrDefault(t,"nothing to place it against"));places.remove(t);done(t);dropHelper(t);}
            waiting.removeAll(layer);
        }
    }
    private final Map<Target,String> whyWaiting=new HashMap<>();
    /** The target is placed or given up: its cells are free, unless another target still goes there. */
    private void done(Target t){release(t.pos(),t);if(t.extra()!=null)release(t.extra(),t);}
    private void release(BlockPos p,Target t){for(Target o:places)if(o!=t&&(o.pos().equals(p)||p.equals(o.extra())))return;pendingCells.remove(p);}

    // ---------- helpers: a temporary block to click on (the end of a beam with nothing beside it) ----------
    private final Set<Target> helpers=new HashSet<>();
    private final Map<Target,BlockPos> helperOf=new HashMap<>();
    private final Map<Target,Set<BlockPos>> helperTried=new HashMap<>();
    private final Set<BlockPos> helperDigs=new HashSet<>();
    private int helpersUsed;
    /**
     * Put a spare block (dirt, planks...) in an empty cell beside `t`, on something solid, for `t` to be clicked against;
     * sideways or below only, so it belongs to this layer or an earlier one. A cell a later target needs may be used:
     * the helper is dug out again right after `t` goes in. The faces the wanted state asks for are tried first (the ends
     * of a beam for its axis, the wall a wall torch hangs on).
     */
    private boolean helper(Target t) {
        Set<BlockPos> tried=helperTried.computeIfAbsent(t,k->new HashSet<>());
        if(tried.size()>=4)return false;
        Item item=scaffoldItem(1);
        if(item==null){whyWaiting.putIfAbsent(t,"nothing to click on for this state and no spare blocks (dirt, planks...) for a temporary one");return false;}
        List<Direction> order=new ArrayList<>();
        BlockState wanted=t.state();
        if(wanted.hasProperty(BlockStateProperties.AXIS)){Direction.Axis axis=wanted.getValue(BlockStateProperties.AXIS);if(axis!=Direction.Axis.Y){order.add(Direction.fromAxisAndDirection(axis,Direction.AxisDirection.NEGATIVE));order.add(Direction.fromAxisAndDirection(axis,Direction.AxisDirection.POSITIVE));}}
        if(wanted.hasProperty(BlockStateProperties.HORIZONTAL_FACING))order.add(wanted.getValue(BlockStateProperties.HORIZONTAL_FACING).getOpposite());
        for(Direction d:List.of(Direction.NORTH,Direction.EAST,Direction.SOUTH,Direction.WEST,Direction.DOWN))if(!order.contains(d))order.add(d);
        AABB body=player.getBoundingBox();
        for(Direction d:order) {
            BlockPos cell=t.pos().relative(d);
            if(tried.contains(cell)||helperOf.containsValue(cell)||!level().isLoaded(cell)||body.intersects(new AABB(cell)))continue;
            BlockState there=level().getBlockState(cell);
            if(!(there.isAir()||there.canBeReplaced()&&there.getFluidState().isEmpty()&&there.getShape(level(),cell).isEmpty()))continue;
            boolean held=false;
            for(Direction e:Direction.values()){BlockPos m=cell.relative(e);if(!m.equals(t.pos())&&!level().getBlockState(m).getShape(level(),m).isEmpty()){held=true;break;}}
            if(!held)continue;
            dropHelper(t);
            Target helper=new Target(cell,((BlockItem)item).getBlock().defaultBlockState(),List.of(),item,null,false);
            places.add(helper);helpers.add(helper);helperOf.put(t,cell);pendingCells.add(cell);tried.add(cell);helpersUsed++;
            note("helper at "+cell.toShortString()+" for "+t.pos().toShortString());
            return true;
        }
        return false;
    }
    /** Dig out the helper put down for `t`, if any (and forget it if it never went in). */
    private void dropHelper(Target t) {
        BlockPos cell=helperOf.remove(t);if(cell==null)return;
        if(places.removeIf(h->helpers.contains(h)&&h.pos().equals(cell)&&!level().getBlockState(cell).is(h.state().getBlock())))release(cell,null);
        if(level().getBlockState(cell).isAir())return;
        helperDigs.add(cell);if(!digs.contains(cell))digs.add(cell);
    }

    // ---------- reach ----------
    /** The hit a player standing at `feet` would get on this block (and face), or null when blocked or too far. */
    private BlockHitResult hitFrom(Vec3 feet,BlockPos pos,Direction face) {
        Vec3 eye=feet.add(0,player.getEyeHeight(),0);
        var shape=level().getBlockState(pos).getShape(level(),pos,CollisionContext.of(player));
        AABB box=shape.isEmpty()?new AABB(pos):shape.bounds().move(pos);
        // Any face will do when none is asked for: the centre first, then the middle of each face (a neighbour may hide the centre).
        List<Direction> faces=new ArrayList<>();faces.add(face);if(face==null)faces.addAll(List.of(Direction.values()));
        for(Direction aimAt:faces) {
            BlockHitResult hit=level().clip(new ClipContext(eye,SurvivalActions.aimPoint(box,aimAt),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
            if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(pos)||face!=null&&hit.getDirection()!=face)continue;
            if(eye.distanceTo(hit.getLocation())<=player.blockInteractionRange()-0.25)return hit;
        }
        return null;
    }
    /** Would the body standing at `feet` be inside a block still to be placed? */
    private boolean overlaps(Vec3 feet) {
        AABB body=new AABB(feet.x-0.3,feet.y,feet.z-0.3,feet.x+0.3,feet.y+1.8,feet.z+0.3);
        for(BlockPos p:BlockPos.betweenClosed(BlockPos.containing(body.minX,body.minY,body.minZ),BlockPos.containing(body.maxX,body.maxY-1e-6,body.maxZ)))
            if(pendingCells.contains(p))return true;
        return false;
    }
    /** Spots on a face of an outline box, centre first, then towards the edges and corners. */
    static List<Vec3> facePoints(AABB box,Direction face) {
        double[] steps={0.5,0.2,0.8};List<Vec3> out=new ArrayList<>();
        for(double u:steps)for(double v:steps) {
            double x=box.minX+(box.maxX-box.minX)*u,y=box.minY+(box.maxY-box.minY)*v,z=box.minZ+(box.maxZ-box.minZ)*(face.getAxis()==Direction.Axis.Y?v:u);
            switch(face) {
                case UP -> out.add(new Vec3(x,box.maxY,z)); case DOWN -> out.add(new Vec3(x,box.minY,z));
                case EAST -> out.add(new Vec3(box.maxX,y,z)); case WEST -> out.add(new Vec3(box.minX,y,z));
                case SOUTH -> out.add(new Vec3(x,y,box.maxZ)); case NORTH -> out.add(new Vec3(x,y,box.minZ));
            }
        }
        return out;
    }
    static float yaw(Vec3 delta){return (float)Math.toDegrees(Math.atan2(-delta.x,delta.z));}
    static float pitch(Vec3 delta){return (float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance()));}
    /**
     * A right-click from `feet` that places exactly the wanted state: on a face of a neighbour (seen, in reach, facing
     * the eye), at a spot and with a way of looking that the game's own placement turns into that state. Null if none.
     */
    private Click clickFrom(Vec3 feet,Target t) {
        Vec3 eye=feet.add(0,player.getEyeHeight(),0);double reach=player.blockInteractionRange()-0.25;
        if(eye.distanceToSqr(Vec3.atCenterOf(t.pos()))>(reach+1)*(reach+1))return null;
        String why=null;
        for(Direction toSupport:Direction.values()) {
            BlockPos support=t.pos().relative(toSupport);Direction face=toSupport.getOpposite();
            if(pendingCells.contains(support)&&level().getBlockState(support).isAir())continue;
            var shape=level().getBlockState(support).getShape(level(),support,CollisionContext.of(player));
            if(shape.isEmpty())continue;
            AABB box=shape.bounds().move(support);
            for(Vec3 point:facePoints(box,face)) {
                Vec3 delta=point.subtract(eye);
                if(delta.lengthSqr()>reach*reach)continue;
                if(delta.x*face.getStepX()+delta.y*face.getStepY()+delta.z*face.getStepZ()>=0)continue; // the face looks away from the eye
                BlockState state=simulate(t,new BlockHitResult(point,face,support,false),yaw(delta),pitch(delta));
                if(state==null||!matches(state,t)){if(state!=null)why="no click from here gives the wanted state";continue;}
                Vec3 inside=point.subtract(face.getStepX()*0.001,face.getStepY()*0.001,face.getStepZ()*0.001);
                BlockHitResult seen=level().clip(new ClipContext(eye,inside,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
                if(seen.getType()!=HitResult.Type.BLOCK||!seen.getBlockPos().equals(support)||seen.getDirection()!=face)continue;
                Vec3 at=seen.getLocation().subtract(eye);
                BlockState again=simulate(t,seen,yaw(at),pitch(at));
                if(again!=null&&matches(again,t))return new Click(seen,yaw(at),pitch(at));
            }
        }
        if(why!=null)whyWaiting.put(t,why);
        return null;
    }
    /** The state the game would place for this click and way of looking, sneaking (so the support is never used), or null. */
    private BlockState simulate(Target t,BlockHitResult hit,float yaw,float pitch) {
        if(!(t.item() instanceof BlockItem item))return null;
        float oldYaw=player.getYRot(),oldPitch=player.getXRot();boolean sneaking=player.isShiftKeyDown();
        try {
            player.setYRot(yaw);player.setXRot(pitch);player.setShiftKeyDown(true);
            BlockPlaceContext context=item.updatePlacementContext(new BlockPlaceContext(player,InteractionHand.MAIN_HAND,new ItemStack(item),hit));
            if(context==null||!context.canPlace()||!context.getClickedPos().equals(t.pos()))return null;
            BlockState state=((BlockItemInvoker)item).mcbot$placementState(context);
            return state!=null&&state.canSurvive(level(),t.pos())?state:null;
        } catch(RuntimeException broken) { return null; }
        finally { player.setYRot(oldYaw);player.setXRot(oldPitch);player.setShiftKeyDown(sneaking); }
    }

    // ---------- walking ----------
    private void walkTo(Object work,Predicate<Vec3> goal) {
        if(work!=walkingTo){stopWalking();walkingTo=work;walkStarted=now();spot=null;stallAt=null;dropWalk=false;}
        walkGoal=goal;
        if(spot==null||!goal.test(spot)) {
            if(navigation!=null)navigation.stop();navigation=null;
            spot=standSpot(work instanceof Target t?t.pos():work instanceof ItemEntity e?e.blockPosition():(BlockPos)work,goal);
            if(spot==null&&!(work instanceof ItemEntity)&&mode==Mode.GROUND&&leftColumns.isEmpty()&&planColumn(work instanceof Target t?t.pos():(BlockPos)work,goal,work)){stopWalking();mode=Mode.TO_COLUMN;note("scaffold "+columnHeight+" at "+column.toShortString()+" for "+label(work));return;}
            // Every spot left was found unreachable: one of them up on a roof may still be climbed onto.
            if(spot==null&&work instanceof Target t&&leftColumns.isEmpty()){Vec3 up=standSpot(t.pos(),goal,true);if(up!=null){stopWalking();if(climbTo(up,work))return;}}
            if(spot==null){giveUp(work,"no place to stand within reach");return;}
            note("walk to "+String.format("%.1f %.1f %.1f",spot.x,spot.y,spot.z)+" for "+(work instanceof Target t?t.pos().toShortString():work instanceof BlockPos p?p.toShortString():"?"));
        }
        if(now()-walkStarted>WALK_MS){unreachableSpots.add(spotCell(spot));if(navigation!=null)note("walk timed out: "+navigation.diagnostics());giveUp(work,"walk timed out");return;}
        // Standing on the spot and still unable to do it from here (a hair off the centre it was worked out for): another spot.
        Vec3 at=player.position();
        if(!(work instanceof ItemEntity)&&work!=column&&player.onGround()&&Math.hypot(at.x-spot.x,at.z-spot.z)<NativeNavigation.WAYPOINT&&Math.abs(at.y-spot.y)<0.6&&!goal.test(at)){
            unreachableSpots.add(spotCell(spot));note("spot no good on arrival");spot=null;if(navigation!=null)navigation.stop();navigation=null;return;
        }
        // Planning over and over without moving (a half-built floor the planner keeps routing into): drop the spot early.
        if(stallAt==null||at.distanceToSqr(stallAt)>0.25){stallAt=at;stallSince=now();}
        else if(now()-stallSince>STALL_MS){unreachableSpots.add(spotCell(spot));if(navigation!=null)note("not moving: "+navigation.diagnostics());giveUp(work,"not moving");return;}
        if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation).roomy().tolerateDamage().drops(dropWalk?safeDrop():0);} // tick() judges damage
        try{navigation.tick(spot,goal);}
        catch(Protocol.Error failure) {
            // No way by steps: up on a roof or an awning, a player jumps down. Once per walk, no further than leaves half the health.
            if(failure.code.equals("NO_PATH")&&!dropWalk&&safeDrop()>3&&spot.y<player.getY()-3){dropWalk=true;navigation.stop();navigation=null;note("no way by steps: may jump down up to "+safeDrop());return;}
            if(failure.code.equals("NO_PATH")||failure.code.equals("OUT_OF_REACH")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){unreachableSpots.add(spotCell(spot));giveUp(work,"cannot walk there ("+failure.code+")");return;}
            throw failure;
        }
    }
    /** The cell the feet are in when standing on a spot (on a slab the spot is half a block into the cell below it). */
    static BlockPos spotCell(Vec3 spot){return new BlockPos(Mth.floor(spot.x),(int)Math.ceil(spot.y-1e-6),Mth.floor(spot.z));}
    /** The standable spot nearest the body, around `near`, where the goal holds (at most MAX_SPOTS tried). */
    private Vec3 standSpot(BlockPos near,Predicate<Vec3> goal){return standSpot(near,goal,false);}
    private Vec3 standSpot(BlockPos near,Predicate<Vec3> goal,boolean evenUnreachable) {
        List<Vec3> spots=new ArrayList<>();
        for(int dx=-SPOT_RADIUS;dx<=SPOT_RADIUS;dx++)for(int dz=-SPOT_RADIUS;dz<=SPOT_RADIUS;dz++)for(int dy=-5;dy<=2;dy++){BlockPos c=near.offset(dx,dy,dz);if(!evenUnreachable&&unreachableSpots.contains(c))continue;Vec3 f=standable(c);if(f!=null)spots.add(f);}
        Vec3 from=player.position();spots.sort(Comparator.comparingDouble(f->f.distanceToSqr(from)));
        int tried=0;
        for(Vec3 f:spots){if(++tried>MAX_SPOTS)break;if(goal.test(f))return f;}
        return null;
    }
    private Vec3 standable(BlockPos cell) {
        if(!level().isLoaded(cell))return null;
        BlockState feet=level().getBlockState(cell),head=level().getBlockState(cell.above()),floor=level().getBlockState(cell.below());
        if(!feet.getCollisionShape(level(),cell).isEmpty()||!head.getCollisionShape(level(),cell.above()).isEmpty())return null;
        if(FlatApproach.hazard(feet)||FlatApproach.hazard(head)||FlatApproach.hazard(floor)||!feet.getFluidState().isEmpty())return null;
        var support=floor.getCollisionShape(level(),cell.below());
        if(support.isEmpty())return null;
        return new Vec3(cell.getX()+0.5,cell.getY()-1+support.max(Direction.Axis.Y),cell.getZ()+0.5);
    }
    private void giveUp(Object work,String why) {
        if(work instanceof ItemEntity e){stopWalking();lostDrops.add(e.getUUID());return;}
        // Cannot get back onto a column stepped off from: dig it from wherever it can be reached instead.
        if(work instanceof BlockPos p&&p.equals(returning)) {
            stopWalking();note("give up the way back to a scaffold: "+why);returning=null;
            Left l=leftColumns.removeFirst();for(BlockPos c:l.cells()){helperDigs.add(c);columnDigs.add(c);if(!digs.contains(c))digs.add(c);}
            return;
        }
        // Up on a floor stepped onto from a column, and this cannot be reached from up here: back down that column first
        // (leaving the floor any other way loses the way back to it), then try again from below.
        if(!leftColumns.isEmpty()&&mode==Mode.GROUND){stopWalking();note("back to the scaffold first, for "+label(work)+" ("+why+")");goBack=true;return;}
        Predicate<Vec3> reach=walkGoal;Vec3 tried=spot;
        stopWalking();note("give up "+label(work)+": "+why);
        if(mode==Mode.TO_COLUMN&&work==column) {
            mode=Mode.GROUND;
            // Another base not yet found unreachable (walls built so far may cut the body off from the outside ones).
            Object f=columnFor;column=null;columnFor=null;climbing=false;
            if(columnTries.merge(f,1,Integer::sum)<=6&&(f instanceof Target ct&&places.contains(ct)?planColumn(ct):f instanceof BlockPos cp&&digs.contains(cp)&&planColumn(cp,p->hitFrom(p,cp,null)!=null,cp))){
                mode=Mode.TO_COLUMN;note("scaffold "+columnHeight+" at "+column.toShortString()+" for "+label(f)+" instead");return;
            }
            column=null;columnFor=f;
            String reason="could not reach a spot for a scaffold ("+why+")";
            if(columnFor instanceof Target ct){waiting.add(ct);whyWaiting.putIfAbsent(ct,reason);}else if(columnFor instanceof BlockPos cp&&digs.contains(cp))failDig(cp,reason);
            column=null;columnFor=null;return;
        }
        // A spot that could not be walked to (up on the roof, behind the walls): try standing on a scaffold instead.
        if(reach!=null&&mode==Mode.GROUND&&!why.startsWith("no place to stand")&&planColumn(work instanceof Target t?t.pos():(BlockPos)work,reach,work)){
            mode=Mode.TO_COLUMN;note("scaffold "+columnHeight+" at "+column.toShortString()+" for "+label(work));return;
        }
        if(tried!=null&&why.startsWith("cannot walk")&&climbTo(tried,work))return;
        if(work instanceof Target t){waiting.add(t);whyWaiting.putIfAbsent(t,why);}
        else failDig((BlockPos)work,why);
    }
    /** The spot is up on a roof or floor no steps lead to: a column right beside it, as high as a step up onto it. */
    private boolean climbTo(Vec3 s,Object work) {
        if(mode!=Mode.GROUND||!(work instanceof Target)||s.y<=player.getY()+1.2||climbTries.merge(BlockPos.containing(s),1,Integer::sum)>2)return false;
        if(!planColumn(BlockPos.containing(s),top->s.y-top.y>=-0.6&&s.y-top.y<=1.2&&Math.abs(top.x-s.x)+Math.abs(top.z-s.z)<1.1,work))return false;
        climbing=true;mode=Mode.TO_COLUMN;note("scaffold "+columnHeight+" at "+column.toShortString()+" to climb onto "+BlockPos.containing(s).toShortString());return true;
    }
    private Predicate<Vec3> walkGoal;
    private boolean dropWalk;
    /** How far the body may jump down and land with at least half its health (fall damage is the fall less three). */
    private int safeDrop(){return Math.min(8,(int)Math.floor(player.getHealth()-player.getMaxHealth()/2)+2);} // one block of margin: a step off an edge falls a little further
    private static String label(Object work){return work instanceof Target t?t.pos().toShortString():work instanceof BlockPos p?p.toShortString():"?";}
    /** A block that could not be dug out: reported, and so is whatever was to go in its place. */
    private void failDig(BlockPos p,String why) {
        digs.remove(p);skip(p,level().getBlockState(p),"could not dig: "+why);
        places.removeIf(t->{if(t.pos().equals(p)||p.equals(t.extra())){skip(t.pos(),t.state(),"the block in the way could not be dug");done(t);return true;}return false;});
    }
    private void stopWalking(){if(navigation!=null)navigation.stop();navigation=null;walkingTo=null;spot=null;}
    /**
     * Only on the ground floor with nothing half done: not digging, no scaffold standing or left behind (up on a roof),
     * not on the way back to one, not wrapping up after the time limit. Up there it finishes and comes down first.
     */
    @Override public boolean interruptible(){return mode==Mode.GROUND&&digging==null&&scaffold.isEmpty()&&leftColumns.isEmpty()&&!goBack&&!wrappingUp&&player.onGround();}
    /** The walk starts over from where the fight left the body; damage from the fight is not counted. */
    @Override public void resumeAfterGuard(long fightMs){stopWalking();player.stopInput();health=player.getHealth();deadline+=grace.grant(fightMs);}

    // ---------- doing ----------
    private void select(int slot){if(player.getInventory().selected!=slot)player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot));}
    /** Hold a stack the test accepts: from the hotbar, or swapped up from the main inventory. */
    private boolean hold(Predicate<ItemStack> wanted) {
        Inventory inventory=player.getInventory();
        if(wanted.test(inventory.getSelected()))return true;
        for(int i=0;i<9;i++)if(wanted.test(inventory.getItem(i))){select(i);return true;}
        for(int i=9;i<36;i++)if(wanted.test(inventory.getItem(i))){
            int hotbar=-1;for(int h=0;h<9;h++)if(inventory.getItem(h).isEmpty()){hotbar=h;break;}
            if(hotbar<0)hotbar=inventory.selected;
            click(player,player.inventoryMenu,menuSlot(player.inventoryMenu,inventory,i),hotbar,ClickType.SWAP);
            if(!wanted.test(inventory.getItem(hotbar)))throw error("UNKNOWN","Could not move the item into the hotbar");
            select(hotbar);return true;
        }
        return false;
    }
    private void place(Target t,Click click) {
        Item item=t.item();
        if(!hold(s->plain(s)&&s.is(item))){skip(t.pos(),t.state(),"ran out of "+id(item));places.remove(t);done(t);return;}
        int had=plainCount(item);
        player.setYRot(click.yaw());player.setYHeadRot(click.yaw());player.setXRot(click.pitch());
        boolean sneaking=player.isShiftKeyDown();player.setShiftKeyDown(true);
        try{player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,click.hit(),++sequence));}
        finally{player.setShiftKeyDown(sneaking);}
        player.swing(InteractionHand.MAIN_HAND,true);
        BlockState actual=level().getBlockState(t.pos());int used=had-plainCount(item);
        places.remove(t);waiting.clear();
        // What was out of reach may not be any more (stairs went in, the body is elsewhere): offered again, now and then.
        if(now()-spotsForgotten>20_000){unreachableSpots.clear();columnTries.clear();climbTries.clear();spotsForgotten=now();}
        note((mode==Mode.UP?"up: ":"")+(helpers.contains(t)?"helper ":"placed ")+t.pos().toShortString()+" used "+used+(matches(actual,t)?"":" WRONG "+actual));
        if(matches(actual,t)){if(!helpers.contains(t))placed++;if(mode==Mode.UP)placedUp++;done(t);dropHelper(t);return;}
        done(t);
        if(actual.is(t.state().getBlock())&&used==1){if(wrong.size()<12)wrong.add(obj("at",pos(t.pos()),"wanted",t.state().toString(),"got",actual.toString()));skippedCount++;skippedWhy.merge("placed with another state",1,Integer::sum);return;}
        if(used>0)throw error("UNKNOWN","The item was used but "+t.pos().toShortString()+" is now "+actual+"; observe before repeating");
        skip(t.pos(),t.state(),"the game refused the placement");
    }
    private void action(ServerboundPlayerActionPacket.Action action,BlockPos pos,Direction face){player.connection.handlePlayerAction(new ServerboundPlayerActionPacket(action,pos,face,++sequence));}
    /** The fastest tool for this block that still drops it, or an empty hand / plain block when nothing helps. */
    private void bestTool(BlockState state) {
        Inventory inventory=player.getInventory();int best=-1;float speed=1;
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(s.isEmpty())continue;
            if(state.requiresCorrectToolForDrops()&&!s.isCorrectToolForDrops(state))continue;
            float v=s.getDestroySpeed(state);if(v>speed){speed=v;best=i;}}
        if(best>=0){ItemStack tool=inventory.getItem(best);hold(s->s==tool);}
        else if(inventory.getSelected().isDamageableItem())hold(s->s.isEmpty()||!s.isDamageableItem());
    }
    private void dig(BlockPos pos,BlockHitResult hit) {
        BlockState state=level().getBlockState(pos);
        bestTool(state);
        look(player,hit.getLocation());
        action(ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK,pos,hit.getDirection());
        player.swing(InteractionHand.MAIN_HAND,true);
        if(level().getBlockState(pos).equals(state)) {
            if(!((ServerPlayerGameModeAccessor)player.gameMode).mcbot$isDestroyingBlock()){abortDig(pos,hit.getDirection());digFailed(pos,"the game refused breaking");return;}
            digging=pos;digState=state;digFace=hit.getDirection();digDeadline=now()+15_000;return;
        }
        dug(pos);
    }
    private void tickDig() {
        BlockPos pos=digging;
        if(!level().getBlockState(pos).equals(digState)){abortDig(pos,digFace);digging=null;scaffoldDig=false;return;}
        if(now()>digDeadline||hitFrom(player.position(),pos,scaffoldDig?Direction.UP:null)==null){abortDig(pos,digFace);digging=null;digFailed(pos,now()>digDeadline?"breaking took too long":"lost reach while breaking");return;}
        var mining=(ServerPlayerGameModeAccessor)player.gameMode;
        float progress=digState.getDestroyProgress(player,level(),pos)*(mining.mcbot$gameTicks()-mining.mcbot$destroyProgressStart()+1);
        if(progress<1){player.swing(InteractionHand.MAIN_HAND,true);return;}
        action(ServerboundPlayerActionPacket.Action.STOP_DESTROY_BLOCK,pos,digFace);
        BlockState after=level().getBlockState(pos);digging=null;
        if(after.equals(digState)){abortDig(pos,digFace);digFailed(pos,"the game refused breaking");return;}
        dug(pos);
    }
    /** A scaffold block dug back is not part of the build's count. */
    private void dug(BlockPos pos){if(scaffoldDig){scaffoldDig=false;scaffold.remove(pos);return;}digs.remove(pos);if(!helperDigs.remove(pos))dug++;}
    private void digFailed(BlockPos pos,String why){if(scaffoldDig){scaffoldDig=false;mode=Mode.GROUND;column=null;columnFor=null;return;}giveUp(pos,why);}
    private void abortDig(BlockPos pos,Direction face) {
        try{action(ServerboundPlayerActionPacket.Action.ABORT_DESTROY_BLOCK,pos,face);}catch(RuntimeException ignored){}
        var mining=(ServerPlayerGameModeAccessor)player.gameMode;mining.mcbot$destroying(false);mining.mcbot$delayed(false);
        level().destroyBlockProgress(player.getId(),pos,-1);
    }

    // ---------- the end ----------
    JsonObject progress() {
        return obj("cells",targets.size(),"already",already,"placed",placed,"dug",dug,"remaining",places.size()+digs.size(),"skippedCount",skippedCount,
            "skipped",skipped,"skippedWhy",skippedWhy,"wrongState",wrong,"scaffoldUsed",scaffoldUsed,"helpersUsed",helpersUsed,"falls",falls,"trace",new ArrayList<>(trace),"scaffoldLeft",java.util.stream.Stream.of(scaffold.stream(),leftColumns.stream().flatMap(l->l.cells().stream()),columnDigs.stream().filter(p->!level().getBlockState(p).isAir())).flatMap(s->s).distinct().map(NativeWorkstation::pos).toList(),"inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())),
            "position",obj("x",player.getX(),"y",player.getY(),"z",player.getZ()));
    }
    private void finish(String code) {
        stopWalking();player.stopInput();
        JsonObject result=progress();
        int left=places.size()+digs.size();
        if(code!=null){result.addProperty("code",code);operation.finish("failed",code+": time limit reached; placed "+placed+", "+left+" left (calling build again continues)",result);return;}
        if(skippedCount==0){operation.finish("succeeded","Built: placed "+placed+", dug "+dug+", "+already+" already right",result);return;}
        result.addProperty("code","INCOMPLETE");
        operation.finish("failed","INCOMPLETE: placed "+placed+", dug "+dug+"; "+skippedCount+" could not be done (see skippedWhy)",result);
    }
    @Override public void stop() {
        if(digging!=null){abortDig(digging,digFace);digging=null;}
        stopWalking();player.stopInput();
    }
}
