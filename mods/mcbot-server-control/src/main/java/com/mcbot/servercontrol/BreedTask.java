package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundInteractPacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.TamableAnimal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.horse.AbstractHorse;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * breed-animals: feed pairs of grown animals of one kind their breeding food, like a player right-clicking them with
 * it (the ordinary interact packet: the animal's own rules decide, vanilla or modded), then wait a little for the
 * babies. Only animals that can fall in love now (grown, not on the breeding cooldown, not already in love) count,
 * and only whole pairs are fed. Tamable animals and horses are left out (taming and owners are their own rules).
 * survey:true only counts.
 */
final class BreedTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,true,"Farm task fault",false);}
    static final int MAX_RADIUS=16,WALK_MS=12_000,BABY_WAIT_MS=8_000;
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final Vec3 center;
    private final int radius,pairs;
    private final EntityType<?> type;
    private final Item food;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final Map<String,Integer> before;
    private final int previousSlot;
    private final Set<UUID> babiesBefore=new HashSet<>(),skipped=new HashSet<>();
    private final List<String> fed=new ArrayList<>();
    private Item using;
    private int toFeed;
    private Animal target;
    private NativeNavigation navigation;
    private long walkStarted,waitUntil;

    BreedTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session,Vec3 center) {
        this.operation=operation;this.player=player;this.session=session;this.center=center;
        JsonObject args=operation.args;
        ResourceLocation key=ResourceLocation.tryParse(string(args,"animal"));
        if(key==null||!BuiltInRegistries.ENTITY_TYPE.containsKey(key))throw error("INVALID_ARGUMENT","Unknown animal "+string(args,"animal"));
        type=BuiltInRegistries.ENTITY_TYPE.get(key);
        food=args.has("food")?item(string(args,"food")):null;
        radius=(int)bounded(args,"radius",12,1,MAX_RADIUS);
        pairs=(int)bounded(args,"pairs",4,1,8);
        long timeout=(long)bounded(args,"timeoutMs",120_000,5_000,300_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);
        before=ItemDescriptions.counts(player.getInventory());previousSlot=player.getInventory().selected;
        if(center.distanceTo(player.position())>32)throw error("OUT_OF_REACH","The animals must be within 32 blocks");
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    private AABB area(){return new AABB(center.subtract(radius,4,radius),center.add(radius,4,radius));}
    private List<Animal> animals() {
        List<Animal> found=new ArrayList<>();
        for(Animal a:player.serverLevel().getEntitiesOfClass(Animal.class,area(),a->a.isAlive()&&a.getType()==type&&a.position().distanceTo(center)<=radius))found.add(a);
        found.sort(Comparator.comparingDouble(a->a.distanceToSqr(player)));
        return found;
    }
    /** Grown, off cooldown and not in love: ready to be fed for breeding. */
    static boolean ready(Animal animal){return !animal.isBaby()&&animal.getAge()==0&&animal.canFallInLove()&&!(animal instanceof TamableAnimal)&&!(animal instanceof AbstractHorse);}
    private boolean edible(Animal animal,ItemStack stack){return !stack.isEmpty()&&(food==null||stack.is(food))&&StationJob.safely(()->animal.isFood(stack),false);}
    private int foodCount(Animal sample,Item item){int n=0;for(int i=0;i<36;i++){ItemStack s=player.getInventory().getItem(i);if(s.is(item)&&edible(sample,s))n+=s.getCount();}return n;}

    JsonObject survey() {
        List<Animal> all=animals();int ready=0,babies=0,cooldown=0,inLove=0;
        for(Animal a:all){if(a.isBaby())babies++;else if(a.isInLove())inLove++;else if(ready(a))ready++;else cooldown++;}
        JsonObject result=obj("animal",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"total",all.size(),"ready",ready,"babies",babies,"inLove",inLove,"cooldown",cooldown);
        if(!all.isEmpty()) {
            Animal sample=all.getFirst();JsonArray foods=new JsonArray();Set<Item> seen=new HashSet<>();
            for(int i=0;i<36;i++){ItemStack s=player.getInventory().getItem(i);if(edible(sample,s)&&seen.add(s.getItem()))foods.add(obj("item",id(s),"count",foodCount(sample,s.getItem())));}
            result.add("foodHeld",foods);
        }
        return result;
    }

    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        List<Animal> all=animals();
        if(!all.isEmpty()&&all.stream().allMatch(a->a instanceof TamableAnimal||a instanceof AbstractHorse))throw error("UNSUPPORTED","Tamable animals and horses are not bred by this action");
        for(Animal a:all)if(a.isBaby())babiesBefore.add(a.getUUID());
        List<Animal> ready=all.stream().filter(BreedTask::ready).toList();
        if(all.isEmpty())throw error("NO_ANIMALS","No "+BuiltInRegistries.ENTITY_TYPE.getKey(type)+" within "+radius+" blocks");
        if(ready.size()<2){JsonObject s=survey();operation.finish("failed","NOT_READY: fewer than two can breed now (babies, cooldown or in love)",withChange(addCode(s,"NOT_READY")));return;}
        Animal sample=ready.getFirst();
        for(int i=0;i<36&&using==null;i++){ItemStack s=player.getInventory().getItem(i);if(edible(sample,s)&&foodCount(sample,s.getItem())>=2)using=s.getItem();}
        if(using==null){JsonObject s=survey();operation.finish("failed","NO_FOOD: not two of the breeding food for "+BuiltInRegistries.ENTITY_TYPE.getKey(type),withChange(addCode(s,"NO_FOOD")));return;}
        int byFood=foodCount(sample,using)/2;
        toFeed=2*Math.min(pairs,Math.min(ready.size()/2,byFood));
    }
    private static JsonObject addCode(JsonObject result,String code){result.addProperty("code",code);return result;}

    private boolean hold(Item item) {
        Inventory inventory=player.getInventory();
        if(inventory.getSelected().is(item))return true;
        for(int i=0;i<9;i++)if(inventory.getItem(i).is(item)){player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(i));return true;}
        for(int i=9;i<36;i++)if(inventory.getItem(i).is(item)){
            int hotbar=-1;for(int h=0;h<9;h++)if(inventory.getItem(h).isEmpty()){hotbar=h;break;}
            if(hotbar<0)hotbar=inventory.selected;
            click(player,player.inventoryMenu,menuSlot(player.inventoryMenu,inventory,i),hotbar,ClickType.SWAP);
            if(!inventory.getItem(hotbar).is(item))throw error("UNKNOWN","Could not move the food into the hotbar");
            player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(hotbar));return true;
        }
        return false;
    }
    /** Close enough to right-click (vanilla allows the interaction range plus one) and nothing solid in between. */
    private boolean inReach(Vec3 feet,Animal animal) {
        Vec3 eye=feet.add(0,player.getEyeHeight(),0);AABB box=animal.getBoundingBox();
        Vec3 nearest=new Vec3(Math.clamp(eye.x,box.minX,box.maxX),Math.clamp(eye.y,box.minY,box.maxY),Math.clamp(eye.z,box.minZ,box.maxZ));
        if(eye.distanceTo(nearest)>player.entityInteractionRange()-0.3)return false;
        return player.serverLevel().clip(new ClipContext(eye,box.getCenter(),ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,player)).getType()==HitResult.Type.MISS;
    }

    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(waitUntil>0) {
            if(now()>=waitUntil||babies().size()*2>=fed.size())finish(null);
            return;
        }
        if(now()>=deadline){finish("Time limit reached");return;}
        if(fed.size()>=toFeed||!hasFood()){waitUntil=now()+BABY_WAIT_MS;stopWalking();return;}
        if(target==null||!target.isAlive()||!ready(target)) {
            stopWalking();target=null;
            for(Animal a:animals())if(ready(a)&&!skipped.contains(a.getUUID())&&edible(a,new ItemStack(using))){target=a;break;}
            // An odd one out with no partner left to feed: stop and say so.
            if(target==null){waitUntil=now()+BABY_WAIT_MS;return;}
            walkStarted=now();
        }
        if(player.onGround()&&inReach(player.position(),target)) {
            stopWalking();player.stopInput();
            if(!hold(using)){waitUntil=now()+BABY_WAIT_MS;return;}
            look(player,target.getEyePosition());
            int held=total(player.getInventory(),using);
            player.connection.handleInteract(ServerboundInteractPacket.createInteractionPacket(target,false,InteractionHand.MAIN_HAND));
            if(target.isInLove()&&total(player.getInventory(),using)<held)fed.add(target.getUUID().toString());
            else skipped.add(target.getUUID());
            target=null;return;
        }
        if(now()-walkStarted>WALK_MS){skipped.add(target.getUUID());target=null;stopWalking();return;}
        if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation);}
        Animal chased=target;
        try { navigation.tick(chased.position(),feet->inReach(feet,chased)); }
        catch(Protocol.Error failure) {
            if(failure.code.equals("NO_PATH")||failure.code.equals("OUT_OF_REACH")||failure.code.equals("PATH_BUDGET")){skipped.add(chased.getUUID());target=null;stopWalking();return;}
            throw failure;
        }
    }
    private boolean hasFood(){return using!=null&&total(player.getInventory(),using)>0;}
    private List<Animal> babies(){return animals().stream().filter(a->a.isBaby()&&!babiesBefore.contains(a.getUUID())).toList();}
    private void stopWalking(){if(navigation!=null)navigation.stop();navigation=null;}
    /** Walking up to an animal; not while feeding it. */
    @Override public boolean interruptible(){return navigation!=null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){stopWalking();player.stopInput();deadline+=grace.grant(fightMs);}
    private JsonObject withChange(JsonObject result){result.add("inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())));return result;}
    JsonObject progress() {
        JsonObject result=obj("animal",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"fed",fed.size(),"babies",babies().size());
        if(using!=null)result.addProperty("food",id(using));
        if(fed.size()%2==1)result.addProperty("unpaired",1);
        if(!skipped.isEmpty())result.addProperty("couldNotFeed",skipped.size());
        return withChange(result);
    }
    private void finish(String early) {
        stop();JsonObject result=progress();
        if(fed.isEmpty()){result.addProperty("code",early!=null?"TIMEOUT":"UNREACHABLE");operation.finish("failed",(early!=null?"TIMEOUT: ":"UNREACHABLE: ")+"fed no animal",result);return;}
        operation.finish("succeeded",(early!=null?early+"; ":"")+"Fed "+fed.size()+", "+babies().size()+" babies so far",result);
    }
    @Override public void stop() {
        stopWalking();player.stopInput();
        try{if(player.getInventory().selected!=previousSlot)player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(previousSlot));}catch(RuntimeException ignored){}
    }
}
