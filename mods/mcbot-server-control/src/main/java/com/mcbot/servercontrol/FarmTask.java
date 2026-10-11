package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.mixin.ServerPlayerGameModeAccessor;
import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.protocol.game.*;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.tags.ItemTags;
import net.minecraft.tags.TagKey;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.*;
import net.minecraft.world.phys.shapes.CollisionContext;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * tend-crops: harvest ripe crops in an area, pick up what they drop, plant the same crop again, optionally plant empty
 * farmland and spend bone meal, like a player walking the field. Every block change goes through the ordinary player
 * packets (break: START/STOP_DESTROY_BLOCK; plant, bone meal, berries: use item on block), so protection, spawn
 * protection and mods see a player. Crops are recognised by kind: ordinary crops (CropBlock or #minecraft:crops with
 * an age property, modded ones too), nether wart, cocoa, sweet berries (picked, not broken), melons and pumpkins
 * grown from an attached stem (decorative ones are left alone) and sugar cane above its bottom block. Stems,
 * torchflowers and pitcher plants are never broken. till:N turns the N moist dirt or grass blocks nearest the centre
 * (water within 4 blocks) into farmland with a hoe, sown in the same pass when plant is given. survey:true only counts
 * and touches nothing.
 */
final class FarmTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,true,"Farm task fault",false);}
    enum Kind { CROP, WART, COCOA, BERRY, GOURD, CANE }
    record Crop(BlockPos pos,Kind kind,BlockState state) {}
    /** Put `seed` on `soil`'s `face` so that `pos` becomes `block` (replanting a harvested crop or planting empty farmland). */
    record Plant(BlockPos pos,Item seed,BlockPos soil,Direction face,Block block,boolean replant) {}
    /** Dirt or grass to turn into farmland with a hoe. */
    record Till(BlockPos pos) {}
    static final int MAX_RADIUS=16,VERTICAL=3,WALK_MS=10_000;
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final Vec3 center;
    private final int radius;
    private final boolean replant;
    private final Item plantItem;
    private int boneMeal;
    private final Predicate<BlockState> filter;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final Map<String,Integer> before;
    private final int previousSlot;
    private final Set<UUID> preexisting=new HashSet<>(),skippedDrops=new HashSet<>();
    private final List<Crop> ripe=new ArrayList<>();
    private final List<Plant> plants=new ArrayList<>();
    private final List<BlockPos> growing=new ArrayList<>();
    private final List<Till> tills=new ArrayList<>();
    private final Set<BlockPos> unreachable=new HashSet<>();
    private final Map<String,Integer> harvested=new TreeMap<>(),notPlanted=new TreeMap<>();
    private final int till;
    private int replanted,planted,boneMealUsed,tilled,sequence,cooldown;
    private boolean inventoryFull;
    private long lastHarvest;
    // walking
    private NativeNavigation navigation;
    private Object walkingTo;
    private long walkStarted,arrivedAt;
    // breaking a block that takes time (melon, pumpkin)
    private BlockPos digging;
    private BlockState digState;
    private Direction digFace;
    private long digDeadline;

    FarmTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session,Vec3 center) {
        this.operation=operation;this.player=player;this.session=session;this.center=center;
        JsonObject args=operation.args;
        radius=(int)integer(args,"radius",8,1,MAX_RADIUS);
        replant=!args.has("replant")||bool(args,"replant");
        plantItem=args.has("plant")?item(string(args,"plant")):null;
        boneMeal=(int)integer(args,"boneMeal",0,0,64);
        till=(int)integer(args,"till",0,0,64);
        filter=filter(args);
        long timeout=(long)bounded(args,"timeoutMs",180_000,5_000,600_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);
        before=ItemDescriptions.counts(player.getInventory());previousSlot=player.getInventory().selected;
        if(center.distanceTo(player.position())>32)throw error("OUT_OF_REACH","The field must be within 32 blocks");
        if(plantItem!=null&&!(plantItem instanceof BlockItem))throw error("INVALID_ARGUMENT",id(plantItem)+" cannot be planted");
        if(till>0&&!args.has("survey")&&!hasHoe())throw error("NO_HOE","Tilling needs a hoe in the inventory");
    }
    private boolean hasHoe(){for(int i=0;i<36;i++)if(player.getInventory().getItem(i).is(ItemTags.HOES))return true;return false;}
    private static double integer(JsonObject args,String key,int fallback,int min,int max) {
        double value=bounded(args,key,fallback,min,max);
        if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");
        return value;
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private ServerLevel level(){return player.serverLevel();}

    /** crops: block IDs, the crop's item (minecraft:carrot finds carrots) or #block tags; empty means every kind. */
    private static Predicate<BlockState> filter(JsonObject args) {
        if(!args.has("crops"))return state->true;
        if(!args.get("crops").isJsonArray()||args.getAsJsonArray("crops").isEmpty()||args.getAsJsonArray("crops").size()>8)throw error("INVALID_ARGUMENT","crops must list 1-8 IDs");
        List<Predicate<BlockState>> any=new ArrayList<>();
        for(JsonElement element:args.getAsJsonArray("crops")) {
            if(!element.isJsonPrimitive()||!element.getAsJsonPrimitive().isString())throw error("INVALID_ARGUMENT","crops must be strings");
            String value=element.getAsString();
            if(value.startsWith("#")) {
                ResourceLocation key=ResourceLocation.tryParse(value.substring(1));
                if(key==null)throw error("INVALID_ARGUMENT","Bad tag "+value);
                TagKey<Block> tag=TagKey.create(Registries.BLOCK,key);any.add(state->state.is(tag));continue;
            }
            ResourceLocation key=ResourceLocation.tryParse(value);
            if(key==null||!BuiltInRegistries.BLOCK.containsKey(key)&&!BuiltInRegistries.ITEM.containsKey(key))throw error("INVALID_ARGUMENT","Unknown crop "+value);
            Block block=BuiltInRegistries.BLOCK.containsKey(key)?BuiltInRegistries.BLOCK.get(key):null;
            Item item=BuiltInRegistries.ITEM.containsKey(key)?BuiltInRegistries.ITEM.get(key):null;
            any.add(state->state.is(block)||item!=null&&(state.getBlock().asItem()==item||item instanceof BlockItem b&&b.getBlock()==state.getBlock()||produces(state,item)));
        }
        return state->any.stream().anyMatch(p->p.test(state));
    }
    /** The crop's own item: wheat for wheat, carrot for carrots, melon slice for a melon. */
    private static boolean produces(BlockState state,Item item) {
        String block=BuiltInRegistries.BLOCK.getKey(state.getBlock()).getPath(),wanted=BuiltInRegistries.ITEM.getKey(item).getPath();
        return block.equals(wanted)||block.equals(wanted+"s")||block.equals(wanted+"es")||state.is(Blocks.MELON)&&item==Items.MELON_SLICE||state.is(Blocks.SUGAR_CANE)&&item==Items.SUGAR_CANE;
    }

    // ---------- recognising crops ----------
    static IntegerProperty age(BlockState state) {
        for(Property<?> property:state.getProperties())if(property instanceof IntegerProperty p&&p.getName().equals("age"))return p;
        return null;
    }
    static boolean neverHarvested(Block block){return block instanceof StemBlock||block instanceof AttachedStemBlock||block instanceof TorchflowerCropBlock||block instanceof PitcherCropBlock;}
    /** What kind of crop this block is, or null; `ripe` says whether it is ready now. */
    static Kind kind(BlockState state) {
        Block block=state.getBlock();
        if(neverHarvested(block))return null;
        if(block instanceof NetherWartBlock)return Kind.WART;
        if(block instanceof CocoaBlock)return Kind.COCOA;
        if(block instanceof SweetBerryBushBlock)return Kind.BERRY;
        if(block instanceof SugarCaneBlock)return Kind.CANE;
        if(state.is(Blocks.MELON)||state.is(Blocks.PUMPKIN))return Kind.GOURD;
        if((block instanceof CropBlock||state.is(BlockTags.CROPS))&&age(state)!=null)return Kind.CROP;
        return null;
    }
    static boolean ripe(ServerLevel level,BlockPos pos,BlockState state,Kind kind) {
        return switch(kind) {
            case CROP -> state.getBlock() instanceof CropBlock crop?crop.isMaxAge(state):state.getValue(age(state))>=Collections.max(age(state).getPossibleValues());
            case WART -> state.getValue(NetherWartBlock.AGE)>=3;
            case COCOA -> state.getValue(CocoaBlock.AGE)>=2;
            case BERRY -> state.getValue(SweetBerryBushBlock.AGE)>=2;
            // Only a fruit an attached stem points at: a placed melon or pumpkin is decoration.
            case GOURD -> Direction.Plane.HORIZONTAL.stream().anyMatch(d->{BlockState s=level.getBlockState(pos.relative(d));return s.getBlock() instanceof AttachedStemBlock&&s.getValue(AttachedStemBlock.FACING)==d.getOpposite();});
            // The lowest cane above the bottom one: breaking it brings the rest down, the bottom grows again.
            case CANE -> level.getBlockState(pos.below()).is(state.getBlock())&&!level.getBlockState(pos.below(2)).is(state.getBlock());
        };
    }
    /** The item that plants this crop again, when it is a plain block item for exactly this block. */
    static Item seed(ServerLevel level,BlockPos pos,BlockState state) {
        ItemStack clone=StationJob.safely(()->state.getBlock().getCloneItemStack(level,pos,state),ItemStack.EMPTY);
        return !clone.isEmpty()&&clone.getItem() instanceof BlockItem item&&item.getBlock()==state.getBlock()?clone.getItem():null;
    }
    /** Dirt or grass a hoe turns into farmland that stays moist: air above, water within 4 blocks at its level or one up (vanilla hydration). */
    static boolean tillable(ServerLevel level,BlockPos pos) {
        BlockState state=level.getBlockState(pos);
        if(!state.is(Blocks.DIRT)&&!state.is(Blocks.GRASS_BLOCK)||!level.getBlockState(pos.above()).isAir())return false;
        for(BlockPos near:BlockPos.betweenClosed(pos.offset(-4,0,-4),pos.offset(4,1,4)))if(level.getFluidState(near).is(FluidTags.WATER))return true;
        return false;
    }

    private List<BlockPos> area() {
        List<BlockPos> found=new ArrayList<>();BlockPos origin=BlockPos.containing(center);
        for(int x=-radius;x<=radius;x++)for(int z=-radius;z<=radius;z++){
            if(x*x+z*z>radius*radius)continue;
            for(int y=-VERTICAL;y<=VERTICAL;y++){
                BlockPos pos=origin.offset(x,y,z);
                if(level().isOutsideBuildHeight(pos)||level().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4)==null)continue;
                found.add(pos.immutable());
            }
        }
        return found;
    }
    /** survey: what is in the field, nothing touched. */
    JsonObject survey() {
        Map<String,int[]> counts=new TreeMap<>();int emptyFarmland=0,tillable=0;BlockPos nearest=null;
        for(BlockPos pos:area()) {
            BlockState state=level().getBlockState(pos);
            if(state.getBlock() instanceof FarmBlock&&level().getBlockState(pos.above()).isAir()){emptyFarmland++;continue;}
            if(tillable(level(),pos)){tillable++;continue;}
            Kind kind=kind(state);if(kind==null||!filter.test(state))continue;
            boolean ready=ripe(level(),pos,state,kind);
            // Melons, pumpkins and cane only count where there is something to take.
            if((kind==Kind.GOURD||kind==Kind.CANE)&&!ready)continue;
            int[] c=counts.computeIfAbsent(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),k->new int[2]);
            c[ready?0:1]++;
            if(ready&&(nearest==null||pos.distSqr(player.blockPosition())<nearest.distSqr(player.blockPosition())))nearest=pos;
        }
        JsonObject crops=new JsonObject();
        counts.forEach((key,c)->crops.add(key,obj("ripe",c[0],"growing",c[1])));
        JsonObject result=obj("center",obj("x",center.x,"y",center.y,"z",center.z),"radius",radius,"crops",crops,"emptyFarmland",emptyFarmland,"tillable",tillable);
        if(nearest!=null)result.add("nearestRipe",pos(nearest));
        return result;
    }

    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        for(BlockPos pos:area()) {
            BlockState state=level().getBlockState(pos);
            if(plantItem!=null&&state.getBlock() instanceof FarmBlock&&level().getBlockState(pos.above()).isAir()&&plantItem instanceof BlockItem b)
                plants.add(new Plant(pos.above(),plantItem,pos,Direction.UP,b.getBlock(),false));
            Kind kind=kind(state);if(kind==null||!filter.test(state))continue;
            if(ripe(level(),pos,state,kind))ripe.add(new Crop(pos,kind,state));
            else if(kind==Kind.CROP)growing.add(pos);
        }
        if(till>0) {
            // The nearest moist dirt and grass to the centre, as many as asked.
            List<BlockPos> soil=new ArrayList<>();for(BlockPos pos:area())if(tillable(level(),pos))soil.add(pos);
            // Rings around the centre block (as area() is laid out), not around a corner of it.
            BlockPos origin=BlockPos.containing(center);
            soil.sort(Comparator.comparingDouble(p->{double dx=p.getX()-origin.getX(),dz=p.getZ()-origin.getZ(),dy=p.getY()-origin.getY();return dx*dx+dz*dz+dy*dy*0.01;}));
            for(BlockPos pos:soil.subList(0,Math.min(till,soil.size())))tills.add(new Till(pos));
        }
        for(ItemEntity item:level().getEntitiesOfClass(ItemEntity.class,field()))preexisting.add(item.getUUID());
        if(ripe.isEmpty()&&plants.isEmpty()&&tills.isEmpty()&&(boneMeal==0||growing.isEmpty())) {
            JsonObject result=survey();result.addProperty("nothingToDo",true);
            if(till>0){result.addProperty("code","NO_TILLABLE");operation.finish("failed","NO_TILLABLE: no dirt or grass here with air above and water within 4 blocks; pour water first",withChange(result));return;}
            operation.finish("succeeded","Nothing ripe to harvest here",withChange(result));
        }
    }
    private AABB field(){return new AABB(center.subtract(radius+3,VERTICAL+3,radius+3),center.add(radius+3,VERTICAL+3,radius+3));}

    // ---------- holding the right thing ----------
    private void select(int slot){if(player.getInventory().selected!=slot)player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot));}
    /** Hold a stack the test accepts: from the hotbar, or swapped up from the main inventory. False when there is none. */
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
    private boolean has(Item item){return total(player.getInventory(),item)>0;}

    // ---------- reach ----------
    private Vec3 aim(BlockPos pos,Direction face) {
        BlockState state=level().getBlockState(pos);
        var shape=state.getShape(level(),pos,CollisionContext.of(player));
        return SurvivalActions.aimPoint(shape.isEmpty()?new AABB(pos):shape.bounds().move(pos),face);
    }
    /** The hit a player standing at `feet` would get on this block (and face), or null when blocked or too far. */
    private BlockHitResult hitFrom(Vec3 feet,BlockPos pos,Direction face) {
        Vec3 eye=feet.add(0,player.getEyeHeight(),0);
        BlockHitResult hit=level().clip(new ClipContext(eye,aim(pos,face),ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,player));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(pos)||face!=null&&hit.getDirection()!=face)return null;
        return eye.distanceTo(hit.getLocation())<=player.blockInteractionRange()-0.25?hit:null;
    }
    private BlockPos targetOf(Object work){return work instanceof Crop c?c.pos():work instanceof Plant p?p.soil():work instanceof Till t?t.pos():(BlockPos)work;}
    private Direction faceOf(Object work){return work instanceof Plant p?p.face():work instanceof Till?Direction.UP:null;}

    // ---------- the loop ----------
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(now()>=deadline){finish("Time limit reached");return;}
        if(digging!=null){tickDig();return;}
        if(cooldown>0){cooldown--;return;}
        Object work=choose();
        if(work==null) {
            // Drops of the last harvest may still be in the air.
            // Drops waiting for another try, or still falling.
            if(now()-lastHarvest<1200||retryAt.values().stream().anyMatch(t->t>now())){player.stopInput();return;}
            finish(null);return;
        }
        if(work instanceof ItemEntity item){walkTo(item);return;}
        BlockHitResult hit=player.onGround()?hitFrom(player.position(),targetOf(work),faceOf(work)):null;
        if(hit==null){walkTo(work);return;}
        stopWalking();player.stopInput();
        if(work instanceof Crop crop)harvest(crop,hit);
        else if(work instanceof Plant plant)plant(plant,hit);
        else if(work instanceof Till soil)till(soil,hit);
        else boneMeal((BlockPos)work,hit);
        cooldown=1;
    }
    /** Next job: something in reach first (harvest, plant, bone meal), drops close by, then the nearest thing to walk to. */
    private Object choose() {
        ripe.removeIf(c->!level().getBlockState(c.pos()).equals(c.state()));
        plants.removeIf(p->!level().getBlockState(p.pos()).isAir()||!(level().getBlockState(p.soil()).getBlock() instanceof FarmBlock)&&!p.replant());
        tills.removeIf(t->!tillable(level(),t.pos()));
        List<Object> work=new ArrayList<>();
        for(Crop c:ripe)if(!unreachable.contains(c.pos()))work.add(c);
        if(!tills.isEmpty()&&hasHoe())for(Till t:tills)if(!unreachable.contains(t.pos()))work.add(t);
        for(Plant p:plants)if(!unreachable.contains(p.soil())&&has(p.seed()))work.add(p);
        Vec3 feet=player.position();
        Object best=null;double bestDistance=Double.MAX_VALUE;
        if(player.onGround())for(Object w:work){double d=Vec3.atCenterOf(targetOf(w)).distanceToSqr(feet);if(d<bestDistance&&hitFrom(feet,targetOf(w),faceOf(w))!=null){best=w;bestDistance=d;}}
        if(best!=null)return best;
        ItemEntity drop=nearestDrop();
        if(drop!=null&&drop.distanceTo(player)<=4)return drop;
        Object far=null;double farDistance=Double.MAX_VALUE;
        for(Object w:work){double d=Vec3.atCenterOf(targetOf(w)).distanceToSqr(feet);if(d<farDistance){far=w;farDistance=d;}}
        // Plants waiting for seeds still in the drops: fetch those first.
        if(drop!=null&&(far==null||drop.distanceToSqr(player)<farDistance||plants.stream().anyMatch(p->!has(p.seed()))))return drop;
        if(far!=null)return far;
        if(boneMeal>0&&has(Items.BONE_MEAL)) {
            growing.removeIf(pos->{BlockState s=level().getBlockState(pos);return kind(s)!=Kind.CROP||ripe(level(),pos,s,Kind.CROP)||!(s.getBlock() instanceof BonemealableBlock b)||!b.isValidBonemealTarget(level(),pos,s);});
            BlockPos grow=null;double growDistance=Double.MAX_VALUE;
            for(BlockPos pos:growing){if(unreachable.contains(pos))continue;double d=Vec3.atCenterOf(pos).distanceToSqr(feet);if(d<growDistance){grow=pos;growDistance=d;}}
            return grow;
        }
        return null;
    }
    private ItemEntity nearestDrop() {
        ItemEntity best=null;
        for(ItemEntity item:level().getEntitiesOfClass(ItemEntity.class,field(),e->e.isAlive()&&!preexisting.contains(e.getUUID())&&!skippedDrops.contains(e.getUUID())&&retryAt.getOrDefault(e.getUUID(),0L)<=now()&&(e.onGround()||e.isInWater()))) {
            if(!room(item.getItem())){inventoryFull=true;skippedDrops.add(item.getUUID());continue;}
            if(best==null||item.distanceToSqr(player)<best.distanceToSqr(player))best=item;
        }
        return best;
    }
    private boolean room(ItemStack stack){Inventory inventory=player.getInventory();return inventory.getFreeSlot()>=0||inventory.getSlotWithRemainingSpace(stack)>=0;}
    private void walkTo(Object work) {
        FlatApproach geometry=new FlatApproach(player);
        Predicate<Vec3> goal;
        if(work instanceof ItemEntity item)goal=feet->geometry.itemReach(feet,item.getBoundingBox());
        else {BlockPos target=targetOf(work);Direction face=faceOf(work);goal=feet->hitFrom(feet,target,face)!=null;}
        if(work!=walkingTo){stopWalking();walkingTo=work;walkStarted=now();arrivedAt=0;spot=null;}
        // Walk to a floor spot from which the goal holds: a drop lying in a berry bush or water, or the soil block
        // under a crop, is not itself a place to stand. A drop that bounced or drifted gets a new spot.
        if(spot==null||!goal.test(spot)) {
            if(navigation!=null)navigation.stop();navigation=null;
            spot=standSpot(work instanceof ItemEntity item?BlockPos.containing(item.position()):targetOf(work),goal);
            if(spot==null){giveUp(work,"no place to stand");return;}
        }
        if(now()-walkStarted>WALK_MS){giveUp(work,"walk timed out (stood at "+String.format("%.1f %.1f %.1f",player.getX(),player.getY(),player.getZ())+", aimed for "+String.format("%.1f %.1f %.1f",spot.x,spot.y,spot.z)+(navigation!=null?", "+navigation.diagnostics():"")+")");return;}
        if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation);}
        try {
            if(navigation.tick(new Vec3(spot.x,Math.floor(spot.y+0.5),spot.z),goal)&&work instanceof ItemEntity) {
                // In reach: vanilla picks it up once its pickup delay is over; a drop that never comes is skipped.
                if(arrivedAt==0)arrivedAt=now();else if(now()-arrivedAt>2000)giveUp(work,"not picked up");
            }
        } catch(Protocol.Error failure) {
            // Damage still stops the whole task; a spot that cannot be walked to is only skipped.
            if(failure.code.equals("NO_PATH")||failure.code.equals("OUT_OF_REACH")||failure.code.equals("PATH_BUDGET")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){giveUp(work,failure.code);return;}
            throw failure;
        }
    }
    /** Feet position to walk to (a farmland floor puts them 1/16 below the block line; the route aims at the block). */
    private Vec3 spot;
    /** The standable floor spot nearest the body, within 4 blocks of `near`, where the goal holds. */
    private Vec3 standSpot(BlockPos near,Predicate<Vec3> goal) {
        Vec3 best=null;double bestDistance=Double.MAX_VALUE;
        for(int dx=-4;dx<=4;dx++)for(int dz=-4;dz<=4;dz++)for(int dy=-2;dy<=2;dy++) {
            BlockPos cell=near.offset(dx,dy,dz);Vec3 feet=standable(cell);
            if(feet==null)continue;
            double d=feet.distanceToSqr(player.position());
            if(d<bestDistance&&goal.test(feet)){best=feet;bestDistance=d;}
        }
        return best;
    }
    /** Feet position on this cell when a body can stand there: room for feet and head, a floor, no hazard. */
    private Vec3 standable(BlockPos cell) {
        if(!level().isLoaded(cell))return null;
        BlockState feet=level().getBlockState(cell),head=level().getBlockState(cell.above()),floor=level().getBlockState(cell.below());
        if(!feet.getCollisionShape(level(),cell).isEmpty()||!head.getCollisionShape(level(),cell.above()).isEmpty())return null;
        if(FlatApproach.hazard(feet)||FlatApproach.hazard(head)||FlatApproach.hazard(floor))return null;
        var support=floor.getCollisionShape(level(),cell.below());
        if(support.isEmpty())return null;
        return new Vec3(cell.getX()+0.5,cell.getY()-1+support.max(net.minecraft.core.Direction.Axis.Y),cell.getZ()+0.5);
    }
    private final JsonArray skippedWhy=new JsonArray();
    private final Map<UUID,Integer> attempts=new HashMap<>();
    private final Map<UUID,Long> retryAt=new HashMap<>();
    private void refused(BlockPos pos,String what,String why){unreachable.add(pos);if(skippedWhy.size()<8)skippedWhy.add(obj("what",what,"at",pos(pos),"why",why));}
    private void giveUp(Object work,String why) {
        if(work instanceof ItemEntity item) {
            // A drop may settle somewhere better (out of a bush, up in water): try it again a little later, three times.
            int tries=attempts.merge(item.getUUID(),1,Integer::sum);
            if(tries<3){retryAt.put(item.getUUID(),now()+1500);stopWalking();return;}
            skippedDrops.add(item.getUUID());
        } else unreachable.add(targetOf(work));
        if(skippedWhy.size()<8){Vec3 at=work instanceof ItemEntity item?item.position():Vec3.atCenterOf(targetOf(work));
            skippedWhy.add(obj("what",work instanceof ItemEntity item?"drop "+id(item.getItem()):work instanceof Plant?"plant":work instanceof Crop?"harvest":work instanceof Till?"till":"bone meal","at",obj("x",Math.round(at.x*10)/10.0,"y",Math.round(at.y*10)/10.0,"z",Math.round(at.z*10)/10.0),"why",why));}
        stopWalking();
    }
    private void stopWalking(){if(navigation!=null)navigation.stop();navigation=null;walkingTo=null;}
    /** Walking between crops; not while breaking, planting or using bone meal. */
    @Override public boolean interruptible(){return navigation!=null&&digging==null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){stopWalking();player.stopInput();deadline+=grace.grant(fightMs);}

    // ---------- doing ----------
    private void action(ServerboundPlayerActionPacket.Action action,BlockPos pos,Direction face){player.connection.handlePlayerAction(new ServerboundPlayerActionPacket(action,pos,face,++sequence));}
    private void harvest(Crop crop,BlockHitResult hit) {
        BlockPos pos=crop.pos();BlockState state=level().getBlockState(pos);
        if(crop.kind()==Kind.BERRY) {
            // Picked with a right-click; bone meal in hand would be spent instead.
            if(player.getInventory().getSelected().is(Items.BONE_MEAL)&&!hold(s->!s.is(Items.BONE_MEAL)))throw error("BUSY","Only bone meal in the hotbar; cannot pick berries");
            look(player,hit.getLocation());
            player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
            if(level().getBlockState(pos).equals(state)){refused(pos,"pick berries","the game refused");return;}
            count(harvested,state);ripe.remove(crop);lastHarvest=now();return;
        }
        Item seed=replantable(crop.kind())?seed(level(),pos,state):null;
        if(crop.kind()==Kind.GOURD) {
            if(!hold(s->s.is(ItemTags.AXES)))hold(s->s.isEmpty()||!s.isDamageableItem());
        } else if(player.getInventory().getSelected().isDamageableItem())hold(s->s.isEmpty()||!s.isDamageableItem());
        look(player,hit.getLocation());
        action(ServerboundPlayerActionPacket.Action.START_DESTROY_BLOCK,pos,hit.getDirection());
        player.swing(InteractionHand.MAIN_HAND,true);
        if(level().getBlockState(pos).equals(state)) {
            if(!((ServerPlayerGameModeAccessor)player.gameMode).mcbot$isDestroyingBlock()){abortDig(pos,hit.getDirection());refused(pos,"harvest","the game refused breaking");return;}
            digging=pos;digState=state;digFace=hit.getDirection();digDeadline=now()+8000;ripe.remove(crop);return;
        }
        harvested(crop,state,seed);
    }
    private void harvested(Crop crop,BlockState state,Item seed) {
        count(harvested,state);ripe.remove(crop);lastHarvest=now();
        if(!replant||seed==null)return;
        BlockPos pos=crop.pos();
        if(crop.kind()==Kind.COCOA) {
            Direction facing=state.getValue(CocoaBlock.FACING);
            plants.add(new Plant(pos,seed,pos.relative(facing),facing.getOpposite(),state.getBlock(),true));
        } else plants.add(new Plant(pos,seed,pos.below(),Direction.UP,state.getBlock(),true));
    }
    private void tickDig() {
        BlockPos pos=digging;
        // Changed by someone or something else before our break landed: not ours to count.
        if(!level().getBlockState(pos).equals(digState)){abortDig(pos,digFace);digging=null;return;}
        if(now()>digDeadline||hitFrom(player.position(),pos,null)==null){abortDig(pos,digFace);refused(pos,"harvest",now()>digDeadline?"breaking took too long":"lost reach while breaking");digging=null;return;}
        var mining=(ServerPlayerGameModeAccessor)player.gameMode;
        float progress=digState.getDestroyProgress(player,level(),pos)*(mining.mcbot$gameTicks()-mining.mcbot$destroyProgressStart()+1);
        if(progress<1){player.swing(InteractionHand.MAIN_HAND,true);return;}
        action(ServerboundPlayerActionPacket.Action.STOP_DESTROY_BLOCK,pos,digFace);
        BlockState after=level().getBlockState(pos);digging=null;
        if(after.equals(digState)){abortDig(pos,digFace);refused(pos,"harvest","the game refused breaking");return;}
        Kind kind=kind(digState);
        harvested(new Crop(pos,kind,digState),digState,replantable(kind)?seed(level(),pos,digState):null);
    }
    private static boolean replantable(Kind kind){return kind==Kind.CROP||kind==Kind.WART||kind==Kind.COCOA;}
    private void abortDig(BlockPos pos,Direction face) {
        try{action(ServerboundPlayerActionPacket.Action.ABORT_DESTROY_BLOCK,pos,face);}catch(RuntimeException ignored){}
        var mining=(ServerPlayerGameModeAccessor)player.gameMode;mining.mcbot$destroying(false);mining.mcbot$delayed(false);
        level().destroyBlockProgress(player.getId(),pos,-1);
    }
    private void plant(Plant plant,BlockHitResult hit) {
        if(!hold(s->s.is(plant.seed())))return;
        look(player,hit.getLocation());
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        plants.remove(plant);
        if(level().getBlockState(plant.pos()).is(plant.block())){if(plant.replant())replanted++;else planted++;if(boneMeal>0&&kind(level().getBlockState(plant.pos()))==Kind.CROP)growing.add(plant.pos());}
        else notPlanted.merge("refused by the game",1,Integer::sum);
    }
    private int tillRefused;
    private void till(Till soil,BlockHitResult hit) {
        tills.remove(soil);
        if(!hold(s->s.is(ItemTags.HOES))){tillRefused++;return;}
        look(player,hit.getLocation());
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        BlockPos pos=soil.pos();
        if(!(level().getBlockState(pos).getBlock() instanceof FarmBlock)){tillRefused++;refused(pos,"till","the game refused");return;}
        tilled++;
        // New farmland is sown in the same pass when a seed was given.
        if(plantItem instanceof BlockItem b)plants.add(new Plant(pos.above(),plantItem,pos,Direction.UP,b.getBlock(),false));
    }
    private void boneMeal(BlockPos pos,BlockHitResult hit) {
        if(!hold(s->s.is(Items.BONE_MEAL))){boneMeal=0;return;}
        int held=total(player.getInventory(),Items.BONE_MEAL);
        look(player,hit.getLocation());
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        int used=held-total(player.getInventory(),Items.BONE_MEAL);
        if(used<=0){refused(pos,"bone meal","the game refused");return;}
        boneMealUsed+=used;boneMeal-=used;
    }
    private static void count(Map<String,Integer> map,BlockState state){map.merge(BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString(),1,Integer::sum);}

    // ---------- the end ----------
    private JsonObject withChange(JsonObject result) {
        result.add("inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())));
        return result;
    }
    JsonObject progress() {
        JsonObject result=obj("center",obj("x",center.x,"y",center.y,"z",center.z),"radius",radius,"harvested",harvested,"replanted",replanted);
        if(planted>0||plantItem!=null)result.addProperty("planted",planted);
        if(till>0){result.addProperty("tilled",tilled);if(tills.size()+tillRefused>0)result.addProperty("notTilled",tills.size()+tillRefused);}
        if(boneMealUsed>0)result.addProperty("boneMealUsed",boneMealUsed);
        Map<String,Integer> waiting=new TreeMap<>(notPlanted);
        for(Plant p:plants)waiting.merge(has(p.seed())?"unreachable":"no "+id(p.seed())+" left",1,Integer::sum);
        if(!waiting.isEmpty())result.add("notPlanted",JSON.toJsonTree(waiting));
        int left=(int)ripe.stream().filter(c->unreachable.contains(c.pos())).count();
        if(left>0)result.addProperty("ripeUnreachable",left);
        int drops=(int)level().getEntitiesOfClass(ItemEntity.class,field(),e->e.isAlive()&&!preexisting.contains(e.getUUID())).size();
        if(drops>0)result.addProperty("dropsLeft",drops);
        if(skippedWhy.size()>0)result.add("skippedWhy",skippedWhy);
        if(inventoryFull)result.addProperty("inventoryFull",true);
        return withChange(result);
    }
    private void finish(String early) {
        stop();
        JsonObject result=progress();
        int total=harvested.values().stream().mapToInt(Integer::intValue).sum();
        boolean nothing=total==0&&replanted==0&&planted==0&&boneMealUsed==0&&tilled==0;
        if(nothing){result.addProperty("code",early!=null?"TIMEOUT":"UNREACHABLE");operation.finish("failed",(early!=null?"TIMEOUT: ":"UNREACHABLE: ")+(early!=null?early:"could not reach any of the work"),result);return;}
        operation.finish("succeeded",(early!=null?early+"; ":"")+"Harvested "+total+", replanted "+replanted+(tilled>0?", tilled "+tilled:"")+(planted>0?", planted "+planted:"")+(boneMealUsed>0?", bone meal "+boneMealUsed:""),result);
    }
    @Override public void stop() {
        if(digging!=null){abortDig(digging,digFace);digging=null;}
        stopWalking();player.stopInput();
        try{select(previousSlot);}catch(RuntimeException ignored){}
    }
}
