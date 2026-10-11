package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.workstation.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.tags.ItemTags;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.*;
import net.minecraft.world.item.*;
import net.minecraft.world.level.block.*;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * craft-item and smelt-item: one operation that walks to the workstation when needed (a crafting grid within 16
 * blocks; a processor that can cook the input), opens it like a player and does the slot work in the same tick
 * (NativeWorkstation). Stations are found and driven through their {@link WorkstationAdapter} (vanilla ones are
 * built in, see VanillaWorkstations): the adapter says which block and menu it is and which slot is which port.
 * smelt-item with wait keeps the machine open, standing beside it, until the input is done, then takes the output.
 * Without a crafting grid nearby a 3x3 recipe may place a crafting table from the inventory, making one from planks
 * (or a log) in the own 2x2 grid first when there is none.
 */
final class WorkstationTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::detail,true,"Workstation fault",false);}
    private record Station(BlockPos pos,WorkstationAdapter adapter) {}
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final boolean crafting;
    private final Deque<Station> stations=new ArrayDeque<>();
    private final JsonArray skipped=new JsonArray();
    private final Map<String,Integer> before;
    private NativeNavigation navigation;
    private Station station;
    private long deadline;
    private final long started=now();
    private GuardDuty.Grace grace;
    // crafting
    private Item wanted;
    private int count;
    private List<StationRecipe> plans;
    // smelting
    private Item input,fuel;
    private boolean wait,collectOnly;
    private int expectedOutput,collected;
    private JsonObject loaded;
    private long waitUntil;
    private AbstractContainerMenu furnace;
    private StationLayout furnaceLayout;
    private Item output;

    private WorkstationTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;crafting=operation.name.equals("craft-item");
        before=counts(player.getInventory());
    }
    static WorkstationTask create(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        return new WorkstationTask(operation,player,session);
    }
    /** Starts the task; a refusal throws and leaves its details (what is missing) in {@link #detail}. */
    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","The cursor holds an item");
        if(crafting)beginCraft();else beginSmelt();
    }
    /** Failure details for a thrown refusal (code added by the caller). */
    JsonObject detail(){JsonObject result=failureDetail==null?new JsonObject():failureDetail.deepCopy();if(skipped.size()>0)result.add("skipped",skipped);return result;}
    private static int integer(JsonObject args,String key,int fallback,int min,int max) {
        double value=bounded(args,key,fallback,min,max);
        if(value!=Math.rint(value))throw error("INVALID_ARGUMENT",key+" must be an integer");
        return (int)value;
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private BlockState state(BlockPos pos){return player.serverLevel().getBlockState(pos);}
    /** The adapter for a block, with its own checks failing closed. */
    private static <T> T safely(java.util.function.Supplier<T> call,T fallback) {
        try { return call.get(); } catch(RuntimeException | LinkageError broken) { return fallback; }
    }

    // ---------- craft ----------
    private List<StationRecipe> recipesAt(WorkstationAdapter adapter,BlockState state) {
        return safely(()->adapter.recipes(state).producing(player,wanted),List.of());
    }
    private void beginCraft() {
        JsonObject args=operation.args;wanted=item(string(args,"item"));count=integer(args,"count",1,1,256);
        deadline=now()+(long)bounded(args,"timeoutMs",30_000,1000,120_000);
        WorkstationAdapter own=VanillaWorkstations.INVENTORY;
        plans=recipesAt(own,null);
        Inventory inventory=player.getInventory();
        // The body's own 2x2 grid first, when a small recipe can be laid out now.
        StationLayout grid=own.layout(player.inventoryMenu);
        if(grid!=null)for(StationRecipe plan:plans)if(plan.fits(grid.gridWidth(),grid.gridHeight())&&feasible(plan,inventory,1)>0){craftIn(player.inventoryMenu,grid,plans,null);return;}
        for(BlockPos pos:nearby(state->ModAdapters.workstation(state,Template.GRID_CRAFTER)!=null)) {
            WorkstationAdapter adapter=ModAdapters.workstation(state(pos),Template.GRID_CRAFTER);
            if(adapter!=null)stations.add(new Station(pos,adapter));
        }
        // Some nearby grid (or the vanilla recipes for a table we could place) must be able to make it now.
        boolean feasibleSomewhere=false;List<StationRecipe> all=new ArrayList<>(plans);
        for(Station s:stations)for(StationRecipe plan:recipesAt(s.adapter(),state(s.pos()))){all.add(plan);if(feasible(plan,inventory,1)>0)feasibleSomewhere=true;}
        if(stations.isEmpty())for(StationRecipe plan:plans)if(feasible(plan,inventory,1)>0)feasibleSomewhere=true;
        if(!feasibleSomewhere){stations.clear();throw missingError(all.isEmpty()?plans:all);}
        if(stations.isEmpty()) {
            madeTable=makeTable();
            BlockPos placed=placeTable();
            if(placed==null)throw error("NO_CRAFTING_TABLE","This recipe needs a crafting table (3x3); none within 16 blocks, none in the inventory and no planks or logs to make one");
            stations.add(new Station(placed,VanillaWorkstations.CRAFTING_TABLE));
        }
        next();
    }
    private Protocol.Error missingError(List<StationRecipe> recipes) {
        if(recipes.isEmpty())return error("NO_RECIPE","No ordinary crafting recipe makes "+id(wanted));
        StationRecipe best=null;JsonArray shortest=null;
        for(StationRecipe plan:recipes){int crafts=(count+plan.result().getCount()-1)/plan.result().getCount();JsonArray m=missing(plan,player.getInventory(),crafts);if(shortest==null||m.size()<shortest.size()){best=plan;shortest=m;}}
        failureDetail=obj("recipe",best.id().toString(),"needsTable",!best.fits(2,2),"missing",shortest);
        return error("MISSING_MATERIALS","Not enough materials for "+id(wanted)+": "+shortest);
    }
    JsonObject failureDetail;
    private void craftIn(AbstractContainerMenu menu,StationLayout layout,List<StationRecipe> recipes,BlockPos table) {
        Inventory inventory=player.getInventory();StationRecipe first=null;
        for(StationRecipe plan:recipes)if(plan.fits(layout.gridWidth(),layout.gridHeight())&&feasible(plan,inventory,1)>0){first=plan;break;}
        if(first==null){if(menu!=player.inventoryMenu)closeMenu(player);throw missingError(recipes);}
        int crafts=0,done=0;
        String used=null;
        try {
            for(StationRecipe plan:recipes) {
                if(done>=count)break;
                if(!plan.fits(layout.gridWidth(),layout.gridHeight())||feasible(plan,inventory,1)==0)continue;
                int perCraft=plan.result().getCount();
                int made=craft(player,menu,layout,plan,(count-done+perCraft-1)/perCraft);
                if(made>0)used=plan.id().toString();
                crafts+=made;done+=made*perCraft;
            }
        } finally { if(menu!=player.inventoryMenu)closeMenu(player); }
        JsonObject result=obj("item",id(wanted),"requestedCount",count,"crafts",crafts,"made",done,"recipe",used,"inventoryChange",delta(before,counts(inventory)));
        if(table!=null)result.add("table",pos(table));
        if(placedTable!=null)result.add("placedTable",pos(placedTable));
        if(madeTable)result.addProperty("madeTable",true);
        if(done<count){
            int perCraft=first.result().getCount();
            JsonArray short_=missing(first,inventory,(count-done+perCraft-1)/perCraft);
            result.add("missing",short_);
            if(done==0){result.addProperty("code",short_.isEmpty()?"INVENTORY_FULL":"MISSING_MATERIALS");operation.finish("failed",(short_.isEmpty()?"INVENTORY_FULL":"MISSING_MATERIALS")+": crafted nothing",result);return;}
            operation.finish("succeeded","Crafted "+done+" of "+count+"; the rest is short of materials",result);return;
        }
        operation.finish("succeeded","Crafted "+done+" "+id(wanted),result);
    }
    private BlockPos placedTable;
    private boolean madeTable;
    /** No table to put down: make one in the own 2x2 grid (planks from a log first when needed), as a player would. */
    private boolean makeTable() {
        Inventory inventory=player.getInventory();
        for(int i=0;i<36;i++)if(plain(inventory.getItem(i))&&inventory.getItem(i).is(Items.CRAFTING_TABLE))return false;
        if(gridCraft(Items.CRAFTING_TABLE))return true;
        for(var planks:BuiltInRegistries.ITEM.getTagOrEmpty(ItemTags.PLANKS))if(gridCraft(planks.value()))break;
        return gridCraft(Items.CRAFTING_TABLE);
    }
    private boolean gridCraft(Item item) {
        WorkstationAdapter own=VanillaWorkstations.INVENTORY;StationLayout grid=own.layout(player.inventoryMenu);
        if(grid==null)return false;
        for(StationRecipe plan:safely(()->own.recipes(null).producing(player,item),List.<StationRecipe>of()))
            if(plan.fits(grid.gridWidth(),grid.gridHeight())&&feasible(plan,player.getInventory(),1)>0&&craft(player,player.inventoryMenu,grid,plan,1)>0)return true;
        return false;
    }
    /** Put a crafting table from the inventory down near the body, like a player would, and remember where. */
    private BlockPos placeTable() {
        Inventory inventory=player.getInventory();int slot=-1;
        for(int i=0;i<36;i++)if(plain(inventory.getItem(i))&&inventory.getItem(i).is(Items.CRAFTING_TABLE)){slot=i;break;}
        if(slot<0)return null;
        BlockPos feet=player.blockPosition();BlockPos target=null;
        // Nearest first; a step up or down is fine, and grass or a flower in the way gives way like for a player.
        outer:
        for(int r=1;r<=3;r++)for(int dy:new int[]{0,1,-1})for(int dx=-r;dx<=r;dx++)for(int dz=-r;dz<=r;dz++){
            if(Math.max(Math.abs(dx),Math.abs(dz))!=r)continue;
            BlockPos at=feet.offset(dx,dy,dz);BlockState there=player.serverLevel().getBlockState(at);
            if(!(there.isAir()||there.canBeReplaced()&&there.getFluidState().isEmpty())||!player.serverLevel().getBlockState(at.below()).isFaceSturdy(player.serverLevel(),at.below(),Direction.UP))continue;
            if(new AABB(at).intersects(player.getBoundingBox()))continue;
            if(player.getEyePosition().distanceTo(Vec3.atCenterOf(at))>player.blockInteractionRange()-0.5)continue;
            target=at;break outer;
        }
        if(target==null)throw error("NO_ROOM","No free floor beside the body to put the crafting table down");
        int hotbar=slot;
        if(slot>8){
            hotbar=-1;for(int i=0;i<9;i++)if(inventory.getItem(i).isEmpty()){hotbar=i;break;}
            if(hotbar<0)hotbar=inventory.selected;
            int source=menuSlot(player.inventoryMenu,inventory,slot);
            click(player,player.inventoryMenu,source,hotbar,ClickType.SWAP);
            if(!inventory.getItem(hotbar).is(Items.CRAFTING_TABLE))throw error("UNKNOWN","Could not move the crafting table into the hotbar");
        }
        int previous=inventory.selected;
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(hotbar));
        BlockPos support=target.below();Vec3 aim=new Vec3(target.getX()+0.5,target.getY()+0.001,target.getZ()+0.5);
        look(player,aim);
        player.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,new BlockHitResult(aim,Direction.UP,support,false),0));
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(previous));
        if(!player.serverLevel().getBlockState(target).is(Blocks.CRAFTING_TABLE))throw error("FORBIDDEN","The game refused to place the crafting table");
        placedTable=target.immutable();return placedTable;
    }

    // ---------- smelt ----------
    private Optional<StationRecipe> recipeFor(WorkstationAdapter adapter,BlockState state,Item item) {
        return safely(()->adapter.recipes(state).forInput(player,new ItemStack(item)),Optional.empty());
    }
    private void beginSmelt() {
        JsonObject args=operation.args;
        collectOnly=!args.has("input");
        if(!collectOnly){input=item(string(args,"input"));count=integer(args,"count",1,1,64);}
        if(args.has("fuel"))fuel=item(string(args,"fuel"));
        wait=args.has("wait")&&bool(args,"wait");
        deadline=now()+(long)bounded(args,"timeoutMs",wait?600_000:60_000,1000,900_000);
        if(!collectOnly) {
            int have=0;for(int i=0;i<36;i++){ItemStack s=player.getInventory().getItem(i);if(plain(s)&&s.is(input))have+=s.getCount();}
            if(have<count){failureDetail=obj("missing",JsonParser.parseString("[{\"options\":[\""+id(input)+"\"],\"need\":"+count+",\"have\":"+have+"}]"));throw error("MISSING_MATERIALS","Only "+have+" "+id(input)+" in the inventory");}
        }
        if(args.has("furnace")) {
            JsonObject at=object(args,"furnace");BlockPos pos=new BlockPos((int)number(at,"x"),(int)number(at,"y"),(int)number(at,"z"));
            WorkstationAdapter adapter=player.serverLevel().hasChunkAt(pos)?ModAdapters.workstation(state(pos),Template.PROCESSOR):null;
            if(adapter==null)throw error("NOT_A_FURNACE","No furnace, smoker or blast furnace there");
            stations.add(new Station(pos,adapter));
        } else for(BlockPos pos:nearby(state->{var adapter=ModAdapters.workstation(state,Template.PROCESSOR);return adapter!=null&&(collectOnly||recipeFor(adapter,state,input).isPresent());}))
            stations.add(new Station(pos,ModAdapters.workstation(state(pos),Template.PROCESSOR)));
        if(stations.isEmpty())throw error("NO_FURNACE",collectOnly?"No furnace within 16 blocks":"No furnace, smoker or blast furnace within 16 blocks can cook "+id(input));
        next();
    }
    private void smeltAt(Station at) {
        AbstractContainerMenu menu=player.containerMenu;BlockPos pos=at.pos();WorkstationAdapter adapter=at.adapter();BlockState block=state(pos);
        StationLayout layout=safely(()->adapter.menu(menu)?adapter.layout(menu):null,null);
        int inputSlot=layout==null?-1:layout.slot(Port.INGREDIENT),fuelSlotIndex=layout==null?-1:layout.slot(Port.FUEL),outputSlot=layout==null?-1:layout.slot(Port.RESULT);
        if(inputSlot<0||outputSlot<0){closeMenu(player);skipped.add(obj("furnace",pos(pos),"reason","menu not recognised"));next();return;}
        Inventory inventory=player.getInventory();
        ItemStack inSlot=menu.getSlot(inputSlot).getItem();
        if(!collectOnly&&!inSlot.isEmpty()&&!inSlot.is(input)) { closeMenu(player);skipped.add(obj("furnace",pos(pos),"reason","busy with "+id(inSlot)));next();return; }
        ItemStack outSlot=menu.getSlot(outputSlot).getItem();
        output=outSlot.isEmpty()?null:outSlot.getItem();
        int taken=takeOutput(menu,outputSlot);
        if(collectOnly) { closeMenu(player);finishSmelt(obj("furnace",pos(pos),"type",BuiltInRegistries.BLOCK.getKey(block.getBlock()).toString(),"collected",taken),"Collected "+taken+" from the furnace");return; }
        var recipe=recipeFor(adapter,block,input);
        if(recipe.isEmpty()){closeMenu(player);skipped.add(obj("furnace",pos(pos),"reason","cannot cook "+id(input)));next();return;}
        output=recipe.get().result().getItem();
        int cookTime=recipe.get().ticks();
        java.util.function.ToIntFunction<ItemStack> burn=stack->safely(()->adapter.burnTicks(block,stack),0);
        // Input: from plain stacks, up to the slot's room.
        int room=Math.min(count,input.getDefaultMaxStackSize()-inSlot.getCount()),put=0;
        for(int i=0;i<36&&put<room;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(input))put+=transfer(player,menu,i,inputSlot,room-put);}
        int queued=menu.getSlot(inputSlot).getItem().getCount();
        // Fuel: enough burn time for everything queued; a lit furnace's current burn is not counted (at most one item extra).
        ItemStack fuelSlot=fuelSlotIndex<0?ItemStack.EMPTY:menu.getSlot(fuelSlotIndex).getItem();
        int needTicks=fuelSlotIndex<0?0:queued*cookTime-(fuelSlot.isEmpty()?0:fuelSlot.getCount()*burn.applyAsInt(fuelSlot)),fuelPut=0;
        String fuelId=fuelSlot.isEmpty()?null:id(fuelSlot);
        if(needTicks>0) {
            int best=-1;
            if(fuelSlot.isEmpty()) {
                int bestRank=Integer.MAX_VALUE;
                for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);int ticks=s.isEmpty()?0:burn.applyAsInt(s);int rank=fuel!=null?(plain(s)&&s.is(fuel)&&ticks>0?0:-1):fuelRank(s,input,ticks);if(rank>=0&&rank<bestRank){bestRank=rank;best=i;}}
            } else for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&ItemStack.isSameItemSameComponents(s,fuelSlot)){best=i;break;}}
            if(best>=0) {
                Item kind=inventory.getItem(best).getItem();int perFuel=burn.applyAsInt(inventory.getItem(best));fuelId=id(kind);
                int wantFuel=(needTicks+perFuel-1)/perFuel;
                for(int i=0;i<36&&fuelPut<wantFuel;i++){ItemStack s=inventory.getItem(i);if(plain(s)&&s.is(kind))fuelPut+=transfer(player,menu,i,fuelSlotIndex,wantFuel-fuelPut);}
            }
        }
        ItemStack fuelNow=fuelSlotIndex<0?ItemStack.EMPTY:menu.getSlot(fuelSlotIndex).getItem();
        int coveredTicks=fuelNow.isEmpty()?0:fuelNow.getCount()*burn.applyAsInt(fuelNow);
        boolean lit=safely(()->adapter.working(menu),false);
        int coveredItems=fuelSlotIndex<0?queued:Math.min(queued,cookTime<=0?queued:coveredTicks/cookTime+(lit?1:0));
        loaded=obj("furnace",pos(pos),"type",BuiltInRegistries.BLOCK.getKey(block.getBlock()).toString(),"input",id(input),"added",put,"queued",queued,
            "output",id(output),"cookSeconds",cookTime/20.0,"readyInSeconds",queued*cookTime/20.0,"fuel",fuelId,"fuelAdded",fuelPut,"coveredByFuel",coveredItems);
        if(taken>0)loaded.addProperty("collectedBefore",taken);
        collected=0; // the old product is only collectedBefore; this batch counts from nothing
        if(put==0&&queued==0){closeMenu(player);finishSmelt(loaded,"Nothing was put in");return;}
        if(coveredItems<queued&&!lit)loaded.addProperty("fuelShortItems",queued-coveredItems);
        if(coveredItems==0&&!lit){closeMenu(player);loaded.addProperty("code","NO_FUEL");operation.finish("failed","NO_FUEL: the input is in the furnace but there is no fuel for it",withChange(loaded));station=null;return;}
        if(!wait){closeMenu(player);finishSmelt(loaded,"Loaded "+put+" "+id(input)+"; ready in about "+Math.round(queued*cookTime/20.0)+" s; come back with smelt-item collect");return;}
        furnace=menu;furnaceLayout=layout;expectedOutput=coveredItems;waitUntil=Math.min(deadline,now()+(long)(queued*cookTime*50L)+10_000);
    }
    private int takeOutput(AbstractContainerMenu menu,int slot) {
        ItemStack out=menu.getSlot(slot).getItem();if(out.isEmpty())return 0;
        Item kind=out.getItem();int beforeCount=total(player.getInventory(),kind);
        quickMove(player,menu,slot);
        return total(player.getInventory(),kind)-beforeCount;
    }
    private JsonObject withChange(JsonObject result){result.add("inventoryChange",delta(before,counts(player.getInventory())));if(skipped.size()>0)result.add("skipped",skipped);return result;}
    private void finishSmelt(JsonObject result,String summary){operation.finish("succeeded",summary,withChange(result));station=null;}
    private void tickWait() {
        if(player.containerMenu!=furnace||!furnace.stillValid(player))throw error("STALE_CONTAINER","The furnace closed while waiting");
        int outputSlot=furnaceLayout.slot(Port.RESULT),inputSlot=furnaceLayout.slot(Port.INGREDIENT);
        // Take output as it comes so the slot never fills up.
        collected+=takeOutput(furnace,outputSlot);
        WorkstationAdapter adapter=station.adapter();
        boolean done=collected>=expectedOutput||furnace.getSlot(inputSlot).getItem().isEmpty()&&!safely(()->adapter.working(furnace),false);
        if(!done&&now()<waitUntil)return;
        collected+=takeOutput(furnace,outputSlot);
        closeMenu(player);
        loaded.addProperty("collected",collected);loaded.addProperty("leftInFurnace",furnace.getSlot(inputSlot).getItem().getCount());
        finishSmelt(loaded,done?"Smelted and collected "+collected+" "+id(output):"Waited "+(waitUntil>=deadline?"until the time limit":"the expected time")+"; collected "+collected+" so far");
    }

    // ---------- walking and opening ----------
    private List<BlockPos> nearby(java.util.function.Predicate<BlockState> wantedBlock){return NativeWorkstation.nearby(player,wantedBlock,6);}
    private void next() {
        station=stations.poll();navigation=null;
        if(station==null){
            JsonObject result=withChange(obj("code",crafting?"NO_CRAFTING_TABLE":"NO_FURNACE"));
            operation.finish("failed",(crafting?"NO_CRAFTING_TABLE":"NO_FURNACE")+": no usable workstation nearby",result);return;
        }
        if(Vec3.atCenterOf(station.pos()).distanceTo(player.position())>32)throw error("OUT_OF_REACH","Workstation is more than 32 blocks away");
    }
    boolean waiting(){return furnace!=null;}
    /** Walking to the table or furnace; once a menu is open (crafting, or waiting at the furnace) it finishes first. */
    @Override public boolean interruptible(){return navigation!=null&&furnace==null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){
        if(navigation!=null){navigation.reset();navigation.rebaseHealth();}
        if(grace==null)grace=new GuardDuty.Grace(deadline-started);
        deadline+=grace.grant(fightMs);
    }
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(now()>=deadline&&furnace==null)throw error("TIMEOUT","Workstation task time limit reached");
        if(furnace!=null){tickWait();return;}
        if(station==null)return;
        BlockPos target=station.pos();WorkstationAdapter adapter=station.adapter();BlockState state=state(target);
        if(!safely(()->adapter.block(state),false)){skipped.add(obj("at",pos(target),"reason","gone"));next();return;}
        FlatApproach geometry=new FlatApproach(player);
        if(!(player.onGround()&&geometry.containerReach(player.position(),target))) {
            if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation);}
            try { if(!navigation.tick(Vec3.atCenterOf(target),feet->geometry.containerReach(feet,target)))return; }
            catch(Protocol.Error failure){ if(failure.code.equals("NO_PATH")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){skipped.add(obj("at",pos(target),"reason",failure.code));navigation.stop();next();return;} throw failure; }
            navigation.stop();navigation=null;
        }
        player.stopInput();
        use(player,target);
        if(player.containerMenu==player.inventoryMenu){skipped.add(obj("at",pos(target),"reason","did not open"));next();return;}
        if(crafting) {
            AbstractContainerMenu menu=player.containerMenu;
            StationLayout layout=safely(()->adapter.menu(menu)?adapter.layout(menu):null,null);
            if(layout==null||!layout.isGrid()||layout.slot(Port.RESULT)<0){closeMenu(player);skipped.add(obj("at",pos(target),"reason","did not open"));next();return;}
            craftIn(menu,layout,recipesAt(adapter,state),target);station=null;
        } else smeltAt(station);
    }
    @Override public void stop() {
        if(navigation!=null)navigation.stop();navigation=null;
        try{closeMenu(player);}catch(RuntimeException ignored){}
        furnace=null;station=null;
    }
}
