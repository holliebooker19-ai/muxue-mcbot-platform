package com.mcbot.servercontrol;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.phys.*;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.*;

/**
 * hunt: kill up to `count` grown mobs of one type around a centre, as a player would: walk up, best sword or axe in
 * hand, one full-strength swing at a time, only the target can be hit (the same native attack scope as defense, no
 * sweep). Never players, villagers and traders, golems, owned or leashed animals, anything with a name, babies, or
 * creepers. Drops are picked up only by walking over them, as vanilla does. Stops when health falls to `lowHealth`.
 */
final class HuntTask implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(this::progress,true,"Hunt task fault",false);}
    static final int MAX_RADIUS=16,WALK_MS=15_000;
    private final ControlSession.Operation operation;
    private final BodyPlayer player;
    private final ControlSession session;
    private final Vec3 center;
    private final int radius,count;
    private final float lowHealth;
    private final EntityType<?> type;
    private long deadline;
    private final GuardDuty.Grace grace;
    private final Map<String,Integer> before;
    private final Set<UUID> hit=new HashSet<>(),skipped=new HashSet<>();
    private final List<String> killed=new ArrayList<>();
    private final Map<String,Integer> skippedWhy=new TreeMap<>();
    private float damage;
    private int swings;
    private LivingEntity target;
    private NativeNavigation navigation;
    private long walkStarted;

    HuntTask(ControlSession.Operation operation,BodyPlayer player,ControlSession session,Vec3 center) {
        this.operation=operation;this.player=player;this.session=session;this.center=center;
        JsonObject args=operation.args;
        ResourceLocation key=ResourceLocation.tryParse(string(args,"type"));
        if(key==null||!BuiltInRegistries.ENTITY_TYPE.containsKey(key))throw error("INVALID_ARGUMENT","Unknown entity type "+string(args,"type"));
        type=BuiltInRegistries.ENTITY_TYPE.get(key);
        if(type==EntityType.PLAYER)throw error("FORBIDDEN","Players are never hunted");
        if(type==EntityType.CREEPER)throw error("UNSUPPORTED","Creepers explode when walked up to; the guard deals with them");
        radius=(int)bounded(args,"radius",12,1,MAX_RADIUS);
        count=(int)bounded(args,"count",1,1,16);
        lowHealth=(float)bounded(args,"lowHealth",8,2,18);
        long timeout=(long)bounded(args,"timeoutMs",60_000,5_000,180_000);
        deadline=now()+timeout;grace=new GuardDuty.Grace(timeout);
        before=ItemDescriptions.counts(player.getInventory());
        if(center.distanceTo(player.position())>32)throw error("OUT_OF_REACH","The area must be within 32 blocks");
    }
    private static long now(){return System.nanoTime()/1_000_000;}
    /** What may be hunted at all: the wanted type, grown, and none of the protected kinds. */
    static boolean huntable(LivingEntity e,EntityType<?> type){return e.getType()==type&&e.isAlive()&&!e.isRemoved()&&!e.isBaby()&&!GuardCombat.protectedEntity(e);}
    private List<LivingEntity> candidates() {
        AABB area=new AABB(center.subtract(radius,6,radius),center.add(radius,6,radius));
        List<LivingEntity> found=new ArrayList<>(player.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e!=player&&huntable(e,type)&&e.position().distanceTo(center)<=radius&&!skipped.contains(e.getUUID())));
        found.sort(Comparator.comparingDouble(e->e.distanceToSqr(player)));
        return found;
    }
    JsonObject survey() {
        AABB area=new AABB(center.subtract(radius,6,radius),center.add(radius,6,radius));
        int total=0,babies=0,protectedOnes=0,huntable=0;
        for(LivingEntity e:player.serverLevel().getEntitiesOfClass(LivingEntity.class,area,e->e.getType()==type&&e.isAlive()&&e.position().distanceTo(center)<=radius)) {
            total++;if(e.isBaby())babies++;else if(GuardCombat.protectedEntity(e))protectedOnes++;else huntable++;
        }
        return obj("type",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"total",total,"huntable",huntable,"babies",babies,"protected",protectedOnes);
    }
    void start() {
        if(player.containerMenu!=player.inventoryMenu)throw error("BUSY","Close the current container first");
        if(candidates().isEmpty()){JsonObject s=survey();s.addProperty("code","NO_TARGET");operation.finish("failed","NO_TARGET: no grown, unprotected "+BuiltInRegistries.ENTITY_TYPE.getKey(type)+" within "+radius+" blocks",s);return;}
        armWeapon();
    }
    /** The best sword or axe into the hand (from the hotbar, or swapped in from the inventory); without one, what is held stays. */
    private void armWeapon() {
        Inventory inventory=player.getInventory();int best=-1;
        for(int i=0;i<36;i++){ItemStack s=inventory.getItem(i);if(GuardCombat.meleeWeapon(s)&&(best<0||GuardCombat.weaponRank(s)>GuardCombat.weaponRank(inventory.getItem(best))))best=i;}
        if(best<0||best==inventory.selected)return;
        if(best>8) {
            int hotbar=inventory.selected;for(int h=0;h<9;h++)if(inventory.getItem(h).isEmpty()){hotbar=h;break;}
            int menu=menuSlot(player.inventoryMenu,inventory,best);if(menu<0)return;
            click(player,player.inventoryMenu,menu,hotbar,ClickType.SWAP);best=hotbar;
        }
        player.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(best));
    }
    @Override public void tick() {
        if(!session.mayDrive(operation)){stop();return;}
        if(!operation.status.equals("running"))return;
        if(player.getHealth()<=lowHealth){finish("LOW_HEALTH");return;}
        if(now()>=deadline){finish("TIMEOUT");return;}
        if(target!=null&&!target.isAlive()) {
            if(hit.contains(target.getUUID()))killed.add(target.getUUID().toString());
            target=null;stopWalking();
        }
        if(killed.size()>=count){finish(null);return;}
        if(target==null||!huntable(target,type)) {
            stopWalking();target=null;
            List<LivingEntity> left=candidates();
            if(left.isEmpty()){finish(killed.isEmpty()?"NO_TARGET":null);return;}
            target=left.getFirst();walkStarted=now();
        }
        LivingEntity chased=target;
        if(player.canInteractWithEntity(chased,0)&&player.hasLineOfSight(chased)) {
            stopWalking();player.stopInput();
            if(player.getAttackStrengthScale(0.5f)<1f)return;
            strike(chased);return;
        }
        if(now()-walkStarted>WALK_MS){skip(chased,"walk timed out");return;}
        if(navigation==null){NativeNavigation.conditions(player);if(!player.onGround())return;navigation=new NativeNavigation(player,session,operation).tolerateDamage();}
        try { navigation.tick(chased.position(),feet->feet.distanceTo(chased.position())<=2.4); }
        catch(Protocol.Error failure) {
            if(failure.code.equals("NO_PATH")||failure.code.equals("OUT_OF_REACH")||failure.code.equals("PATH_BUDGET")||failure.code.equals("BLOCKED")&&!failure.getMessage().contains("damage")){skip(chased,failure.code+": "+failure.getMessage());return;}
            throw failure;
        }
    }
    private void strike(LivingEntity e) {
        String id=e.getUUID().toString();float[] dealt={0};RuntimeException[] refused={null};
        NativeAttackScope scope=new NativeAttackScope() {
            public boolean allowNativeTarget(String targetId){return id.equals(targetId)&&session.mayDrive(operation)&&!GuardCombat.protectedEntity(e);}
            public void refuseNative(RuntimeException failure){if(refused[0]==null)refused[0]=failure;}
            public void receipt(String targetId,float amount){if(id.equals(targetId)&&Float.isFinite(amount)&&amount>0)dealt[0]+=amount;}
        };
        look(player,e.getEyePosition());
        SurvivalActions.scopedAttack(player,scope,()->player.attack(e));
        player.swing(InteractionHand.MAIN_HAND,true);swings++;
        if(refused[0]!=null)throw refused[0];
        if(dealt[0]>0){hit.add(e.getUUID());damage+=dealt[0];}
    }
    private void skip(LivingEntity e,String why){skipped.add(e.getUUID());skippedWhy.merge(why,1,Integer::sum);target=null;stopWalking();}
    private void stopWalking(){if(navigation!=null)navigation.stop();navigation=null;}
    /** Walking up to the next one; not in the middle of a swing. */
    @Override public boolean interruptible(){return navigation!=null&&player.onGround();}
    @Override public void resumeAfterGuard(long fightMs){stopWalking();player.stopInput();walkStarted=now();deadline+=grace.grant(fightMs);}
    JsonObject progress() {
        JsonObject result=obj("type",BuiltInRegistries.ENTITY_TYPE.getKey(type).toString(),"requested",count,"killed",killed.size(),"swings",swings,"damage",damage);
        if(!skipped.isEmpty()){result.addProperty("unreachable",skipped.size());JsonObject why=new JsonObject();skippedWhy.forEach(why::addProperty);result.add("unreachableWhy",why);}
        result.add("inventoryChange",delta(before,ItemDescriptions.counts(player.getInventory())));
        return result;
    }
    private void finish(String code) {
        stop();JsonObject result=progress();
        if(code!=null)result.addProperty("code",code);
        String what=killed.size()+" of "+count+" "+BuiltInRegistries.ENTITY_TYPE.getKey(type);
        if(killed.isEmpty()){operation.finish("failed",(code!=null?code:"UNREACHABLE")+": killed none",result);return;}
        operation.finish("succeeded",(code!=null?code+": ":"")+"Killed "+what,result);
    }
    @Override public void stop(){stopWalking();player.stopInput();target=null;}
}
