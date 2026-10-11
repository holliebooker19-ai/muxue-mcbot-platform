package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mcbot.servercontrol.api.workstation.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * Shared skeleton of produce-item and modify-item: candidate stations (nearest first, or the one the agent named),
 * walking into reach with the ordinary navigation, opening with a right-click, checking the opened menu and its
 * layout through the station's adapter, then handing the menu to the job. A station that cannot be reached, does not
 * open as expected or is busy with someone else's items is skipped (listed in the receipt) and the next one tried.
 * A job that waits (brewing) keeps the menu open and is ticked until it finishes.
 */
abstract class StationJob implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::detail,true,"Station task fault",true);}
    record Station(BlockPos pos,WorkstationAdapter adapter) {}
    protected final ControlSession.Operation operation;
    protected final BodyPlayer player;
    protected final ControlSession session;
    protected final Deque<Station> stations=new ArrayDeque<>();
    protected final JsonArray skipped=new JsonArray();
    protected final Map<String,Integer> before;
    protected final int levelsBefore;
    protected Station station;
    protected AbstractContainerMenu open;
    protected StationLayout layout;
    protected JsonObject failureDetail;
    protected long deadline;
    private NativeNavigation navigation;
    private final long started=now();
    private GuardDuty.Grace grace;

    StationJob(ControlSession.Operation operation,BodyPlayer player,ControlSession session) {
        this.operation=operation;this.player=player;this.session=session;
        before=ItemDescriptions.counts(player.getInventory());levelsBefore=player.experienceLevel;
    }
    /** Parse arguments, check materials, choose stations. Throws a refusal before anything is touched. */
    abstract void begin();
    /** The station's menu is open and verified; do the slot work. Leave {@link #open} set to keep waiting. */
    abstract void opened(AbstractContainerMenu menu,StationLayout layout);
    /** Called each tick while the menu stays open for waiting. */
    void waitTick() {}
    /** What this job calls a missing station in its error code. */
    abstract String noStationCode();

    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        if(!player.inventoryMenu.getCarried().isEmpty())throw error("BUSY","The cursor holds an item");
        begin();
        if(operation.status.equals("running")&&station==null)next();
    }
    JsonObject detail(){JsonObject result=failureDetail==null?new JsonObject():failureDetail.deepCopy();if(skipped.size()>0)result.add("skipped",skipped);return result;}
    static <T> T safely(java.util.function.Supplier<T> call,T fallback) {
        try { return call.get(); } catch(RuntimeException | LinkageError broken) { return fallback; }
    }
    protected static long now(){return System.nanoTime()/1_000_000;}
    protected BlockState state(BlockPos pos){return player.serverLevel().getBlockState(pos);}

    /** The named station (args.station {x,y,z}) when given, otherwise nearby blocks one of these adapters accepts. */
    protected void findStations(List<WorkstationAdapter> adapters,java.util.function.BiPredicate<WorkstationAdapter,BlockState> usable) {
        if(operation.args.has("station")) {
            JsonObject at=object(operation.args,"station");BlockPos pos=new BlockPos((int)Math.floor(number(at,"x")),(int)Math.floor(number(at,"y")),(int)Math.floor(number(at,"z")));
            WorkstationAdapter adapter=player.serverLevel().hasChunkAt(pos)?match(adapters,state(pos)):null;
            if(adapter==null||!usable.test(adapter,state(pos)))throw error(noStationCode(),"No usable "+names(adapters)+" at "+pos.toShortString());
            stations.add(new Station(pos,adapter));return;
        }
        for(BlockPos pos:nearby(player,s->{WorkstationAdapter a=match(adapters,s);return a!=null&&usable.test(a,s);},6))stations.add(new Station(pos,match(adapters,state(pos))));
        if(stations.isEmpty())throw error(noStationCode(),"No usable "+names(adapters)+" within 16 blocks");
    }
    private static WorkstationAdapter match(List<WorkstationAdapter> adapters,BlockState state) {
        for(WorkstationAdapter a:adapters)if(safely(()->a.block(state),false))return a;
        return null;
    }
    private static String names(List<WorkstationAdapter> adapters){List<String> ids=new ArrayList<>();for(var a:adapters)ids.add(a.id());return String.join("/",ids);}

    protected void skip(String reason) {
        if(station!=null)skipped.add(obj("at",pos(station.pos()),"station",station.adapter().id(),"reason",reason));
        next();
    }
    protected void next() {
        station=stations.poll();if(navigation!=null)navigation.stop();navigation=null;
        if(station==null){operation.finish("failed",noStationCode()+": no usable station nearby",withChange(obj("code",noStationCode())));return;}
        if(Vec3.atCenterOf(station.pos()).distanceTo(player.position())>32)throw error("OUT_OF_REACH","Station is more than 32 blocks away");
    }
    /** Common receipt tail: inventory change by item identity (components kept) and experience levels. */
    protected JsonObject withChange(JsonObject result) {
        result.add("inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())));
        if(player.experienceLevel!=levelsBefore)result.add("levels",obj("before",levelsBefore,"after",player.experienceLevel));
        if(skipped.size()>0)result.add("skipped",skipped);
        return result;
    }
    protected void succeed(String summary,JsonObject result){closeMenu(player);open=null;operation.finish("succeeded",summary,withChange(result));station=null;}
    protected void fail(String code,String summary,JsonObject result){closeMenu(player);open=null;result.addProperty("code",code);operation.finish("failed",code+": "+summary,withChange(result));station=null;}
    /** The commit may have happened but its result cannot be confirmed: report unknown (observe, never replay), not failed. */
    protected void unknown(String code,String summary,JsonObject result){closeMenu(player);open=null;result.addProperty("code",code);operation.finish("unknown",code+": "+summary,withChange(result));station=null;}
    /** Shift-click every listed slot of the open menu back into the inventory; false when something stayed. */
    protected boolean takeBack(AbstractContainerMenu menu,List<Integer> slots) {
        boolean all=true;for(int slot:slots)all&=quickMove(player,menu,slot);return all;
    }

    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(open!=null) {
            if(player.containerMenu!=open||!open.stillValid(player))throw error("STALE_CONTAINER","The station closed while waiting");
            waitTick();return;
        }
        if(now()>=deadline)throw error("TIMEOUT","Station task time limit reached");
        if(station==null)return;
        BlockPos target=station.pos();WorkstationAdapter adapter=station.adapter();
        if(!safely(()->adapter.block(state(target)),false)){skip("gone");return;}
        FlatApproach geometry=new FlatApproach(player);
        if(!(player.onGround()&&geometry.containerReach(player.position(),target))) {
            if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation);}
            try { if(!navigation.tick(Vec3.atCenterOf(target),feet->geometry.containerReach(feet,target)))return; }
            catch(Protocol.Error failure){ if(failure.code.equals("NO_PATH")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){skip(failure.code);return;} throw failure; }
            navigation.stop();navigation=null;
        }
        player.stopInput();
        use(player,target);
        AbstractContainerMenu menu=player.containerMenu;
        if(menu==player.inventoryMenu){skip("did not open");return;}
        StationLayout verified=safely(()->adapter.menu(menu)?adapter.layout(menu):null,null);
        if(verified==null){closeMenu(player);skip("menu not recognised");return;}
        layout=verified;
        opened(menu,verified);
    }
    /** Walking to the station; once its menu is open the job finishes first (closing it halfway may lose items). */
    @Override public boolean interruptible(){return navigation!=null&&open==null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){
        if(navigation!=null){navigation.reset();navigation.rebaseHealth();}
        if(grace==null)grace=new GuardDuty.Grace(deadline-started);
        deadline+=grace.grant(fightMs);
    }
    @Override public void stop() {
        if(navigation!=null)navigation.stop();navigation=null;
        try{closeMenu(player);}catch(RuntimeException ignored){}
        open=null;station=null;
    }
}
