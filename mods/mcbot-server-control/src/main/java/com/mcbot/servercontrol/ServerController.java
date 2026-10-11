package com.mcbot.servercontrol;

import com.google.gson.*;
import com.mojang.authlib.GameProfile;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.DisconnectionDetails;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.*;
import net.minecraft.server.network.CommonListenerCookie;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.neoforged.neoforge.event.entity.player.ItemEntityPickupEvent;
import net.neoforged.neoforge.event.entity.living.LivingEntityUseItemEvent;
import net.neoforged.bus.api.EventPriority;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.*;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.ServerChatEvent;
import java.nio.file.Files;
import java.util.*;
import java.util.function.Consumer;
import static com.mcbot.servercontrol.Protocol.*;

final class ServerController implements ControlSession.Game {
    static final List<String> CAPABILITIES=List.of("send-chat","look-at","move-to-position","follow-player","dig-block","place-block","open-container","click-slot","close-container","select-slot","drop-item","nearby-blocks","nearby-resources","approach-container","approach-player","approach-resource","pickup-item","companion-pickup","companion-mining","swap-inventory","eat-item","equip-item","survival-state","assess-tool","defend-entity","retreat-from-entity","navigation-3d","look-around","pillar-up","sleep-in-bed","wake-up","craft-item","smelt-item","travel-to","workstation-options","produce-item","modify-item","tend-crops","breed-animals","hunt","use-bucket","emote","set-appearance","build","machine-items","machine-status","guard-duty-fenced","guard-duty-tasks","gift-receipts","entity-equipment","host-notice","last-death","assess-armour","sit","stand-up","server-posture");
    private final MinecraftServer server;
    private final ServerConfig config;
    final ControlSession session;
    private final TargetTokens targets;
    private final ResourceTargets resources;
    private final PickupLedger pickups=new PickupLedger();
    private final ValidationProtection validationProtection;
    private SurvivalActions survival;
    private BodyPlayer player;
    private VirtualConnection sink;
    private boolean wasConnected;
    private String lastDimension;
    private ControlSession.Operation active;
    /** Companion posture (follow, wait, seated): kept across operations and ordinary stops, cleared with the lease (docs/companion_state_design.md, section 7). */
    private Posture posture;
    private boolean postureDrove;
    /** Standing guard: kept across operations and stops, cleared when the lease ends (docs/companion_state_design.md, section 5). */
    private GuardDuty duty;
    private boolean dutyDrove;
    /** When the duty took the body for the current fight, and what was running then (resumed afterwards, its limit extended). */
    private long dutyFrom;
    private ControlSession.Operation dutyPaused;
    /**
     * What drives the body for the running operation (docs/companion_state_design.md 8.3): a task, a walk or a pickup;
     * null for an emote gesture (BodyEmotes drives it) and for the native actions SurvivalActions runs.
     */
    private BodyTask task;
    private final SubjectRefs subjectRefs=new SubjectRefs();
    private int lastDriveTick=Integer.MIN_VALUE;
    private final Consumer<net.neoforged.neoforge.event.entity.living.LivingDamageEvent.Post> damageListener=this::receiveDamage;
    private final Consumer<net.neoforged.neoforge.event.entity.player.AttackEntityEvent> attackGuard=SurvivalActions::guardNativeAttack;
    private final Consumer<net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent> incomingDamageGuard=SurvivalActions::guardNativeIncomingDamage;
    private final Consumer<net.neoforged.neoforge.event.entity.player.SweepAttackEvent> sweepGuard=SurvivalActions::guardNativeSweep;
    private final Consumer<net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent> friendlyFireGuard=this::guardFriendlyFire;
    private final Consumer<net.neoforged.neoforge.event.entity.EntityJoinLevelEvent> projectileMark=this::markBodyProjectile;
    private final IdleGaze gaze=new IdleGaze();
    private final BodyEmotes emotes=new BodyEmotes();
    private ServerPlayer speaker;
    private long spokeAt,gazeHold;
    private final ArrayDeque<JsonObject> chat=new ArrayDeque<>();
    private long chatSequence;
    private ServerChatEvent outgoingChatEvent;
    private final Consumer<LivingEntityUseItemEvent.Finish> foodFinishListener=this::receiveFoodFinish;
    private final Consumer<net.neoforged.neoforge.event.level.BlockEvent.FarmlandTrampleEvent> trampleGuard=this::guardFarmland;
    private final Consumer<net.neoforged.neoforge.event.entity.living.LivingDeathEvent> deathListener=this::recordDeath;
    /** How and where the body last died (vanilla's death message), shown in hello until the next death; null before any. */
    private JsonObject lastDeath;
    /** Marks the items the body dropped when it died, so a recovery after respawn picks up only those (protocol 陪伴姿态, 死亡掉落). */
    static final String DEATH_DROP_TAG="mcbot_body_death_drop";
    /** Vanilla ItemEntity.LIFETIME (private in 1.21.1): an item on the ground despawns after this many ticks. */
    static final int DROP_LIFETIME_TICKS=6000;
    /** At most this many kinds of item listed in lastDeath.drops: an inventory holds 41 stacks, and hello stays short. */
    static final int DEATH_DROP_KINDS=16;
    /** The item entities of the last death's drops; how many are still there is read when hello is asked. */
    private final List<UUID> deathDrops=new ArrayList<>();
    private final Consumer<net.neoforged.neoforge.event.entity.living.LivingDropsEvent> dropsListener=this::recordDrops;
    ServerController(MinecraftServer server,ServerConfig config) {
        this.server=server; this.config=config;
        session=new ControlSession(this,()->System.nanoTime()/1_000_000,config.worldId(),config.username());
        targets=new TargetTokens(session);
        resources=new ResourceTargets(session);
        validationProtection=new ValidationProtection(config.uuid());
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,foodFinishListener);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,damageListener);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,true,attackGuard);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,true,incomingDamageGuard);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,true,sweepGuard);
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST,trampleGuard);
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST,friendlyFireGuard);
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST,projectileMark);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,deathListener);
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST,dropsListener);
    }
    /** A death that went through (not cancelled): the message vanilla is about to print, the place the drops fall, the time. */
    private void recordDeath(net.neoforged.neoforge.event.entity.living.LivingDeathEvent event) {
        if(player==null||event.getEntity()!=player)return;
        String message;try{message=player.getCombatTracker().getDeathMessage().getString();}catch(RuntimeException ignored){message=event.getSource().getMsgId();}
        lastDeath=obj("message",message,"dimension",player.serverLevel().dimension().location().toString(),"position",position(player.position()),"at",System.currentTimeMillis());
        // Nothing dropped until the drops event says so: keepInventory, an empty inventory, or a mod that took the drops (a grave) leave it at 0.
        deathDrops.clear();lastDeath.add("drops",obj("count",0));
    }
    /** The drops of that death (vanilla fires this after the death event, before the items enter the world): tag and count them. */
    private void recordDrops(net.neoforged.neoforge.event.entity.living.LivingDropsEvent event) {
        if(player==null||event.getEntity()!=player||lastDeath==null)return;
        deathDrops.clear();
        Map<String,Integer> kinds=new LinkedHashMap<>();
        for(ItemEntity item:event.getDrops()) {
            item.addTag(DEATH_DROP_TAG);deathDrops.add(item.getUUID());
            kinds.merge(BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),item.getItem().getCount(),Integer::sum);
        }
        JsonArray items=new JsonArray();
        kinds.entrySet().stream().limit(DEATH_DROP_KINDS).forEach(kind->items.add(obj("id",kind.getKey(),"count",kind.getValue())));
        lastDeath.add("drops",obj("count",deathDrops.size(),"items",items,"despawnAt",lastDeath.get("at").getAsLong()+DROP_LIFETIME_TICKS*GuardCombat.TICK_MS));
    }
    /** lastDeath for hello, with how many of the drops are still on the ground: null when that place is not loaded (unknown). */
    private JsonObject deathReport() {
        JsonObject death=lastDeath.deepCopy();
        JsonObject drops=death.getAsJsonObject("drops");
        if(drops==null||drops.get("count").getAsInt()==0)return death;
        var level=server.getLevel(net.minecraft.resources.ResourceKey.create(net.minecraft.core.registries.Registries.DIMENSION,net.minecraft.resources.ResourceLocation.parse(death.get("dimension").getAsString())));
        BlockPos at=BlockPos.containing(point(death.getAsJsonObject("position")));
        if(level==null||!level.hasChunkAt(at)){drops.add("remaining",JsonNull.INSTANCE);return death;}
        int remaining=0;
        for(UUID id:deathDrops){Entity item=level.getEntity(id);if(item!=null&&item.isAlive()&&!item.isRemoved())remaining++;}
        drops.addProperty("remaining",remaining);
        return death;
    }
    /** The body never tramples farmland: a companion walking the player's field must not turn it back to dirt. */
    /** Whatever the body does (a swing, an arrow, a guard fight), it never hurts a player, a pet, a villager or anything named. */
    private void guardFriendlyFire(net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent event){if(GuardCombat.blocksFriendlyFire(player!=null&&event.getSource().getEntity()==player,event.getSource().getDirectEntity()!=null&&event.getSource().getDirectEntity().getTags().contains(GuardCombat.BODY_PROJECTILE_TAG),event.getEntity()==player,GuardCombat.protectedEntity(event.getEntity())))event.setCanceled(true);}
    /** An arrow the body loosed keeps its mark after the body is gone (or its owner reference is), so the guard still knows whose it is. */
    private void markBodyProjectile(net.neoforged.neoforge.event.entity.EntityJoinLevelEvent event){if(player!=null&&!event.getLevel().isClientSide()&&event.getEntity() instanceof net.minecraft.world.entity.projectile.Projectile projectile&&projectile.getOwner()==player)projectile.addTag(GuardCombat.BODY_PROJECTILE_TAG);}
    private void guardFarmland(net.neoforged.neoforge.event.level.BlockEvent.FarmlandTrampleEvent event){if(player!=null&&event.getEntity()==player)event.setCanceled(true);}
    JsonObject call(String method,JsonObject params) {
        reconcile();
        if(Set.of("claim","respawn","act").contains(method))HostingRules.requireRunnable(host());
        return session.call(method,params);
    }
    private HostingRules.Host host() {
        return new HostingRules.Host(server.isDedicatedServer(),server.isPublished(),server.isPaused(),server.getPlayerList().isAllowCommandsForAllPlayers());
    }
    private boolean forbiddenOp(GameProfile profile) {
        return HostingRules.forbiddenOp(host(),server.getPlayerList().isOp(profile),server.getPlayerList().getOps().get(profile)!=null);
    }
    @Override public boolean connected() { return player!=null&&player.isAlive()&&!player.isRemoved()&&sink!=null&&sink.isConnected()&&server.getPlayerList().getPlayer(config.uuid())==player&&player.gameMode.getGameModeForPlayer()==GameType.SURVIVAL&&!forbiddenOp(player.getGameProfile()); }
    void reconcile() {
        boolean live=connected();
        String dimension=player==null?null:player.serverLevel().dimension().location().toString();
        if(wasConnected!=live||(!Objects.equals(dimension,lastDimension)&&lastDimension!=null)) session.bodyChanged();
        wasConnected=live; lastDimension=dimension;
        session.expire();
    }
    void beforeServerTick() {
        reconcile();
        // Vanilla's real connection ticks independently of entity chunks. Our transport must too.
        // No survival or physics tick here: this only acknowledges teleport and moves PLAYER tickets.
        if(connected()) player.pumpLocalTransport();
    }
    @Override public void ensureBody() {
        if(connected()) return;
        if(player!=null&&NativeRespawn.present(player)&&sink!=null&&sink.isConnected()&&server.getPlayerList().getPlayer(config.uuid())==player) {
            if(forbiddenOp(player.getGameProfile())) throw error("FORBIDDEN","Server body refuses an OP identity");
            if(!player.isAlive()) throw error("DEAD_BODY","Body is dead; use explicit native respawn before claiming control");
            throw error("FORBIDDEN","Existing body is not in survival mode; no automatic game-mode change");
        }
        if(player!=null) remove();
        if(server.getPlayerList().getPlayer(config.uuid())!=null||server.getPlayerList().getPlayerByName(config.username())!=null) throw error("WRONG_PLAYER","Configured player identity is already occupied");
        GameProfile profile=new GameProfile(config.uuid(),config.username());
        if(forbiddenOp(profile)) throw error("FORBIDDEN","Server body refuses an OP identity");
        boolean persisted=Files.exists(server.getWorldPath(LevelResource.PLAYER_DATA_DIR).resolve(config.uuid()+".dat"));
        sink=new VirtualConnection(); player=new BodyPlayer(server,server.overworld(),profile,this);
        CommonListenerCookie cookie=CommonListenerCookie.createInitial(profile,false);
        try {
            server.getPlayerList().placeNewPlayer(sink,player,cookie);
            player.connection=new VirtualGameListener(server,sink,player,cookie); sink.setVirtualListener(player.connection);
            survival=new SurvivalActions(player,session,targets,resources);
            if(!player.isAlive()) {
                // Keep vanilla's dead body for explicit PERFORM_RESPAWN, never grant an action lease.
                session.bodyChanged();
                throw error("DEAD_BODY","Saved body is dead; explicitly respawn through the native player path");
            }
            if(!persisted) player.setGameMode(GameType.SURVIVAL);
            if(player.gameMode.getGameModeForPlayer()!=GameType.SURVIVAL) throw error("FORBIDDEN","Saved body is not in survival mode");
            player.setInvulnerable(false);
            if(!persisted&&config.spawnX()!=null) player.teleportTo(server.overworld(),config.spawnX(),config.spawnY(),config.spawnZ(),Set.of(),0,0);
            // placeNewPlayer registered a ticket at the old/default position. Transfer it now,
            // otherwise the new unloaded chunk cannot tick the entity that would transfer it.
            player.pumpLocalTransport();
            player.stopInput(); wasConnected=true; lastDimension=player.serverLevel().dimension().location().toString(); session.bodyChanged();
        } catch(Protocol.Error failure) { if(!failure.code.equals("DEAD_BODY")) remove();throw failure; }
        catch(RuntimeException failure) { remove(); throw failure; }
    }
    @Override public void respawn() {
        if(forbiddenOp(new GameProfile(config.uuid(),config.username()))) throw error("FORBIDDEN","Server body refuses an OP identity");
        if(player!=null&&(!NativeRespawn.present(player)||sink==null||!sink.isConnected()||server.getPlayerList().getPlayer(config.uuid())!=player)) remove();
        if(player==null) {
            NativeRespawn.requireDeadSave(server,config.uuid());
            try { ensureBody(); } catch(Protocol.Error failure) { if(!failure.code.equals("DEAD_BODY")) throw failure; }
        }
        if(survival!=null) survival.stop();
        player=NativeRespawn.perform(player);survival=new SurvivalActions(player,session,targets,resources);
        player.stopInput();player.pumpLocalTransport();wasConnected=connected();lastDimension=player.serverLevel().dimension().location().toString();
    }
    @Override public JsonObject hello() {
        List<com.mcbot.servercontrol.api.ItemInteraction> interactions=ItemInteractions.installed();
        List<String> capabilities=new ArrayList<>(CAPABILITIES);capabilities.addAll(ItemInteractions.capabilities(interactions));
        JsonObject hello=obj("platform",obj("minecraft","1.21.1","loader","neoforge","loaderVersion",loaderVersion()),"capabilities",capabilities);
        hello.add("interactions",ItemInteractions.ids(interactions));
        if(lastDeath!=null)hello.add("lastDeath",deathReport());
        hello.add("itemInteractions",ItemInteractions.itemIds(interactions));
        hello.add("adapters",ModAdapters.containerIds());
        hello.add("seatAdapters",ModAdapters.seatIds());
        hello.add("itemHandlerMods",ModAdapters.itemHandlerModIds());
        hello.add("hints",ModAdapters.hintsJson());
        BodyEmotes.describe(hello,server);
        if(validationProtection.enabled()) hello.add("validationFixture",validationProtection.json());
        return hello;
    }
    @Override public JsonObject observe(JsonObject params) {
        JsonArray inventory=new JsonArray(),entities=new JsonArray();
        for(int i=0;i<player.getInventory().getContainerSize();i++) inventory.add(survival.observedStack(i,player.getInventory().getItem(i)));
        List<EquipmentView.Entry> equipped=new ArrayList<>();
        for(Entity entity:player.serverLevel().getEntities(player,player.getBoundingBox().inflate(32))) {
            if(entity.distanceToSqr(player)>32*32) continue;
            JsonObject seen=obj("id",entity.getUUID().toString(),"type",BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString(),"name",entity instanceof Player p?p.getGameProfile().getName():entity.getName().getString(),"position",position(entity.position()));
            if(entity instanceof Player p)seen.addProperty("sleeping",p.isSleeping());
            if(entity instanceof net.minecraft.world.entity.LivingEntity living)ItemDescriptions.collectEquipment(living,seen,entity.distanceToSqr(player),equipped);
            entities.add(seen);
            if(entities.size()>=64) break;
        }
        // What nearby players and creatures hold and wear (entity-equipment), nearest first and bounded.
        EquipmentView.attach(equipped);
        JsonObject result=obj("connected",true,"username",config.username(),"dimension",player.serverLevel().dimension().location().toString(),"health",player.getHealth(),"food",player.getFoodData().getFoodLevel(),"position",position(player.position()),"yaw",player.getYRot(),"pitch",player.getXRot(),"inventory",inventory,"selectedSlot",player.getInventory().selected,"entities",entities,"chat",chat,"chatCursor",chatSequence,"container",survival.container(),"source","server-observed");
        result.addProperty("sleeping",player.isSleeping());
        result.addProperty("sitting",NativeSeat.seated(player));
        result.add("time",obj("dayTime",player.serverLevel().getDayTime()%24000,"canSleep",player.level().dimensionType().natural()&&!player.level().isDay()));
        // What the body would notice: the sky overhead (not underground or indoors), rain and thunder, for scene hints.
        result.add("weather",obj("natural",player.level().dimensionType().natural(),"sky",player.level().canSeeSky(BlockPos.containing(player.getEyePosition())),"raining",player.level().isRaining(),"thundering",player.level().isThundering()));
        JsonObject drops=groundItems();drops.entrySet().forEach(entry->result.add(entry.getKey(),entry.getValue()));
        pickups.observation().entrySet().forEach(entry->result.add(entry.getKey(),entry.getValue()));
        if(duty!=null) result.add("guard",duty.json());
        if(posture!=null) result.add("posture",posture.json());
        if(params.has("block")) {
            Vec3 requested=point(object(params,"block")); BlockPos block=BlockPos.containing(requested);
            JsonObject state=obj("position",position(Vec3.atLowerCornerOf(block)),"state","unloaded");
            if(player.serverLevel().hasChunkAt(block)) {
                var actual=player.serverLevel().getBlockState(block); JsonObject properties=new JsonObject();
                actual.getValues().forEach((property,value)->properties.addProperty(property.getName(),value.toString()));
                state=obj("position",position(Vec3.atLowerCornerOf(block)),"state","loaded","id",BuiltInRegistries.BLOCK.getKey(actual.getBlock()).toString(),"properties",properties);
            }
            result.add("block",state);
        }
        return result;
    }
    @Override public JsonObject nearbyBlocks(JsonObject params) {
        NearbyBlocks.Options options=NearbyBlocks.options(params);
        ServerPlayer center=player;
        if(options.centerPlayer()!=null&&!options.centerPlayer().equals(player.getGameProfile().getName())) {
            center=findPlayer(options.centerPlayer());
            if(center==null||!NearbyBlocks.visiblePlayer(player,center))
                throw error("INVALID_ARGUMENT","Center player must be visible within 32 blocks in the same dimension");
        }
        return NearbyBlocks.discover(player,center,options,targets);
    }
    @Override public JsonObject nearbyResources(JsonObject params) {return NearbyResources.discover(player,params,resources);}
    @Override public JsonObject lookAround(JsonObject params) {return LookAround.summarize(player,params);}
    @Override public JsonObject survivalState(JsonObject params) {return survival.survivalState(params);}
    @Override public JsonObject assessTool(JsonObject params) {return ToolAssessment.assess(player,params);}
    @Override public JsonObject machineStatus(JsonObject params) {return MachineStatus.read(player,params);}
    @Override public JsonObject assessArmour(JsonObject params) {return ArmourAssessment.assess(player,params);}
    @Override public JsonObject guard(JsonObject params) {
        if(params.has("off")&&bool(params,"off")) { clearDuty(); return obj("enabled",false); }
        String name=string(params,"player"),expected=string(params,"expectedEntityId");
        UUID uuid;
        try { uuid=UUID.fromString(expected); } catch(IllegalArgumentException invalid) { throw error("INVALID_ARGUMENT","expectedEntityId must be a UUID"); }
        GuardCombat.Options options=GuardDuty.options(params);
        ServerPlayer target=findPlayer(name);
        if(target==null) throw error("PLAYER_NOT_VISIBLE","Player to guard is not within 32 blocks in this dimension");
        if(!target.getUUID().equals(uuid)) throw error("STALE_TARGET","Player to guard changed identity");
        clearDuty();
        duty=GuardDuty.create(player,session.dutyPermission(),server,name,uuid,options);
        return duty.json();
    }
    @Override public void clearDuty() {
        GuardDuty old=duty; duty=null;
        if(old!=null) { try { old.stop(); } finally { if(dutyDrove) { dutyDrove=false; if(posture!=null) posture.resumeAfterGuard(); } } }
    }
    @Override public JsonObject posture(JsonObject params) {
        if(params.has("off")&&bool(params,"off")) { clearPosture(); JsonObject off=new JsonObject(); off.add("posture",JsonNull.INSTANCE); return off; }
        long revision=(long)number(params,"postureRevision"); // ordered and validated by the session
        String action=string(params,"action");
        Posture next;
        if(action.equals("wait")) {
            // Sitting is already staying put: a wait keeps the seat (with the new revision).
            next=posture!=null&&posture.kind()==Posture.Kind.SEATED?Posture.seated(posture.seat,revision,postureView()):Posture.waiting(revision,postureView());
        } else if(action.equals("follow")) {
            String name=string(params,"player"),expected=string(params,"expectedEntityId");
            UUID uuid;
            try { uuid=UUID.fromString(expected); } catch(IllegalArgumentException invalid) { throw error("INVALID_ARGUMENT","expectedEntityId must be a UUID"); }
            if(!uuid.toString().equalsIgnoreCase(expected)) throw error("INVALID_ARGUMENT","expectedEntityId must be a complete UUID");
            double distance=bounded(params,"distance",2.5,1.5,6);
            if(params.has("wander")&&!(params.get("wander").isJsonPrimitive()&&params.getAsJsonPrimitive("wander").isBoolean())) throw error("INVALID_ARGUMENT","wander must be a boolean");
            boolean wander=!params.has("wander")||bool(params,"wander");
            ServerPlayer target=findPlayer(name);
            if(target==null) throw error("PLAYER_NOT_VISIBLE","Player to follow is not within 32 blocks in this dimension");
            if(!target.getUUID().equals(uuid)) throw error("STALE_TARGET","Player to follow changed identity");
            java.util.function.BooleanSupplier permission=session.dutyPermission();
            next=Posture.follow(FollowCompanion.create(name,uuid,distance,wander,player,permission,server),revision,postureView(permission));
        } else throw error("INVALID_ARGUMENT","action must be follow or wait, or use off:true");
        clearPosture();
        posture=next;
        return posture.json();
    }
    @Override public void clearPosture() {
        Posture old=posture; posture=null; postureDrove=false;
        if(old!=null) old.halt();
    }
    private Posture.View postureView(){return postureView(session.dutyPermission());}
    /** What the posture may do with the body: bound to this lease and body session, like the guard duty. */
    private Posture.View postureView(java.util.function.BooleanSupplier mayDrive) {
        return new Posture.View() {
            NativeNavigation walk;
            public long now(){return ServerController.now();}
            public boolean mayDrive(){return mayDrive.getAsBoolean();}
            public boolean seated(){return NativeSeat.seated(player);}
            public void standUp(){player.stopRiding();}
            public boolean returnToSeat(BlockPos seat) {
                // The same checks and right-click as the sit operation (beginSit, tickSit).
                NativeSeat.requireCanSit(player);NativeSeat.requireFreeSeat(player,seat);
                if(!NativeSeat.inReach(player.position(),seat)) {
                    if(walk==null)walk=new NativeNavigation(player,mayDrive).tolerateDamage();
                    if(!walk.tick(Vec3.atCenterOf(seat),feet->NativeSeat.inReach(feet,seat)))return false;
                }
                player.stopInput();
                NativeSeat.sitDown(player,seat,ServerController.this::look,()->{});
                return NativeSeat.seated(player);
            }
            public void stopSeatWalk(){if(walk!=null)walk.stop();walk=null;player.stopInput();}
        };
    }
    /**
     * What runs now can stand aside for a fight (docs/companion_state_design.md 5.2): idle, a follow without its own
     * guard, walking, approaching, travelling, and the tasks that say so at this moment (on the ground, nothing half
     * done). Eating, digging, an open menu, a scaffold, a bed, a gesture or a retreat keep the body until they end.
     */
    private boolean dutyMayInterrupt() {
        if(!GuardDuty.bodyFree(survival!=null&&survival.busy(),nativeWriteInProgress(),player.isSleeping(),player.isUsingItem(),dutyDrove,player.containerMenu!=player.inventoryMenu)) return false;
        if(active==null) return true;
        return task!=null&&task.interruptible();
    }
    /** The fight is over: what was paused plans its way again; only the operation that was paused gets the time back. */
    private void resumeAfterFight(long fightMs) {
        if(task!=null) task.resumeAfterGuard(active==dutyPaused?fightMs:0);
    }
    /** True when the duty drove the body this tick. */
    private boolean tickDuty(BodyPlayer body) {
        // Sitting keeps the protection: when the guard would fight, the body gets up first; a seated posture walks back to the seat afterwards.
        if(player.isPassenger()&&NativeSeat.standForFight(NativeSeat.seated(player),true,duty.wouldFight())) player.stopRiding();
        GuardDuty current=duty;
        boolean drove;
        // Idle: nothing runs, and no follow or seat takes the body back after the fight, so the guard walks back to where it stood.
        try { drove=current.tick(dutyMayInterrupt(),active==null&&(posture==null||posture.guardWalksBack())); }
        catch(RuntimeException fault) { drove=false; current.interrupt(); }
        if(current!=duty)return false; // A native callback may have cleared or replaced the duty.
        if(drove) { if(!dutyDrove){dutyFrom=now();dutyPaused=active;} dutyDrove=true; if(posture!=null) posture.guarding(); return true; }
        if(dutyDrove) {
            dutyDrove=false;
            if(active!=null) resumeAfterFight(now()-dutyFrom);
            else { body.stopInput(); if(posture!=null) posture.resumeAfterGuard(); }
            dutyPaused=null;
        }
        return false;
    }
    /**
     * True when the posture drove the body this tick. It yields to a running action unless that action keeps it (KEEPS), and
     * stands still without a pause while a built-in gesture plays (HOLDS, Posture.holdsFor).
     */
    private boolean tickPosture() {
        Posture current=posture;
        List<String> running=session.running();
        String yielded=current.yieldTo(running,emotes.playing()!=null);
        boolean drove;
        try { drove=current.tick(yielded,current.holdsFor(running)); }
        catch(RuntimeException fault) { drove=false; current.halt(); }
        if(current!=posture) return false;
        if(current.ended()) { posture=null; return false; } // the followed name belongs to someone else now
        postureDrove=drove;
        return drove;
    }
    private void receiveFoodFinish(LivingEntityUseItemEvent.Finish event) {
        if(player==event.getEntity()&&survival!=null)survival.receiveFoodFinish(event.getHand()==InteractionHand.MAIN_HAND,event.getItem(),event.getResultStack());
    }
    private JsonObject groundItems() {
        List<ItemEntity> items=player.serverLevel().getEntitiesOfClass(ItemEntity.class,player.getBoundingBox().inflate(8),e->e.isAlive()&&!e.isRemoved()&&e.distanceToSqr(player)<=64&&!e.getItem().isEmpty());
        items.sort(Comparator.comparingDouble((ItemEntity e)->e.distanceToSqr(player)).thenComparing(e->e.getUUID().toString()));
        JsonArray result=new JsonArray();boolean truncated=items.size()>32;
        for(ItemEntity item:items.subList(0,Math.min(32,items.size()))) {
            try {
                String visibility=new FlatApproach(player).itemVisibility(item.position());
                JsonObject seen=groundObservation(item.getUUID().toString(),position(item.position()),survival.stackValue(item.getItem()),visibility,item.onGround());
                if(item.getTags().contains(DEATH_DROP_TAG))seen.addProperty("deathDrop",true);
                result.add(seen);
            }catch(Protocol.Error unsupported){truncated=true;}
        }
        return obj("groundItems",result,"groundItemsTruncated",truncated);
    }
    static JsonObject groundObservation(String entityId,JsonObject position,JsonObject stack,String visibility,boolean onGround) {
        return obj("entityId",entityId,"position",position,"stack",stack,"visibility",visibility,
            "visible",visibility.equals("unknown")?null:visibility.equals("visible"),"onGround",onGround);
    }
    private ItemEntityPickupEvent.Pre pendingPre;
    private ItemStack pendingPreStack;
    private Map<String,Map<String,Integer>> pendingPreStored;
    /**
     * Another mod (e.g. a backpack pickup upgrade) may move the drop into storage during Pre and cancel the vanilla pickup,
     * so no Post event fires. That counts as picked up only when an installed {@link com.mcbot.servercontrol.api.PickupSink}
     * accounts for exactly the absorbed items; otherwise the ledger gets an explicit gap.
     */
    void receivePickupPre(ItemEntityPickupEvent.Pre event,boolean first) {
        if(player==null||survival==null||event.getPlayer()!=player)return;
        ItemEntity entity=event.getItemEntity();
        if(first) {
            pendingPre=event;pendingPreStack=entity.getItem().copy();
            pendingPreStored=ModAdapters.pickupSinks().isEmpty()?Map.of():ModAdapters.stored(player);
            return;
        }
        if(event!=pendingPre)return;
        ItemStack before=pendingPreStack;Map<String,Map<String,Integer>> storedBefore=pendingPreStored;
        pendingPre=null;pendingPreStack=null;pendingPreStored=null;
        ItemStack now=entity.getItem();
        if(event.canPickup()!=net.neoforged.neoforge.common.util.TriState.FALSE||before.isEmpty()||now.getCount()>=before.getCount())return;
        String sink;JsonObject original=null,portion=null;int count=0;
        try {
            original=survival.stackValue(before);count=PickupLedger.pickedUpCount(original,survival.stackValue(now));
            portion=original.deepCopy();portion.addProperty("count",count);
            sink=ModAdapters.absorbedBy(storedBefore,ModAdapters.pickupSinks().isEmpty()?Map.of():ModAdapters.stored(player),string(original,"id"),count);
        }catch(RuntimeException unknown){sink=null;}
        if(sink==null) {
            pickups.unknown();
            PickupItem pickup=pickup();
            if(pickup!=null&&pickup.targets(entity))pickup.fail("PICKUP_UNKNOWN","Another mod moved the drop into storage that no installed adapter accounts for");
            return;
        }
        pickups.record(entity.getUUID().toString(),position(entity.position()),original,survival.stackValue(now),session.sessionId(),session.generation(),player.serverLevel().dimension().location().toString(),sink,thrownBy(entity));
        PickupItem pickup=pickup();
        if(pickup!=null)pickup.picked(entity,true,portion,count,sink);
    }
    void receivePickup(ItemEntityPickupEvent.Post event) {
        if(player==null||survival==null)return;
        ItemEntity entity=event.getItemEntity();
        PickupItem pickup=pickup();
        if(event.getPlayer()!=player&&(pickup==null||!pickup.targets(entity)))return;
        try {
            JsonObject original=survival.stackValue(event.getOriginalStack()),remaining=survival.stackValue(event.getCurrentStack());
            int count=PickupLedger.pickedUpCount(original,remaining);JsonObject portion=original.deepCopy();portion.addProperty("count",count);
            if(event.getPlayer()==player)pickups.record(entity.getUUID().toString(),position(entity.position()),original,remaining,session.sessionId(),session.generation(),player.serverLevel().dimension().location().toString(),null,thrownBy(entity));
            if(pickup!=null)pickup.picked(entity,event.getPlayer()==player,portion,count,null);
        }catch(RuntimeException unknown){if(event.getPlayer()==player)pickups.unknown();if(pickup!=null)pickup.fail("PICKUP_UNKNOWN","Native pickup stack could not be attributed completely");}
    }
    /** The player who threw this item, for the receipt (gift-receipts); a failed lookup only loses the name, never the receipt. */
    private String thrownBy(ItemEntity entity) {
        try {
            Entity thrower=entity.getOwner();
            return PickupLedger.thrownBy(thrower==null?null:thrower.getUUID(),thrower instanceof Player p?p.getGameProfile().getName():null,thrower instanceof Player,player.getUUID());
        }catch(RuntimeException failure){return null;}
    }
    /** The pickup task in the slot, for the native pickup events; null when something else runs. */
    private PickupItem pickup(){return task instanceof PickupItem pickup?pickup:null;}
    @Override public JsonObject watch() { return obj("chat",chat,"chatCursor",chatSequence); }
    /** Gray italic host line to every player; the session already checked length, characters and rate. */
    @Override public void notice(String text) { server.getPlayerList().broadcastSystemMessage(Component.literal(text).withStyle(ChatFormatting.GRAY,ChatFormatting.ITALIC),false); }
    @Override public long chatCursor() { return chatSequence; }
    void receiveChat(ServerChatEvent event) {
        if(event!=outgoingChatEvent&&!event.isCanceled()) recordChat(event.getUsername(),event.getMessage().getString());
    }
    private void recordChat(String username,String message) {
        chat.addLast(obj("seq",++chatSequence,"time",System.currentTimeMillis(),"username",username,"message",message));
        while(chat.size()>100) chat.removeFirst();
        if(!username.equals(config.username())){speaker=server.getPlayerList().getPlayerByName(username);spokeAt=now();if(posture!=null)posture.holdStroll();}
    }
    private void receiveDamage(net.neoforged.neoforge.event.entity.living.LivingDamageEvent.Post event){
        if(survival!=null)survival.receiveDamage(event);
    }
    @Override public void begin(ControlSession.Operation operation) {
        if(!atomicAction(operation.name)) throw error("UNSUPPORTED","Action is not available");
        if(!session.mayDrive(operation)) throw error("LEASE_LOST","Body lease expired before action");
        gazeHold=now()+IdleGaze.HOLD_AFTER_ACTION_MS;
        // Started while the duty fights (between two steps of a gathering, say): it waits for the fight like a paused one and gets that time back.
        if(dutyDrove&&!Posture.keeps(operation.name)){dutyPaused=operation;dutyFrom=now();}
        JsonObject args=operation.args;
        if(player.isSleeping()&&!Set.of("send-chat","wake-up").contains(operation.name)) throw error("SLEEPING","Body is asleep in a bed; call wake-up first");
        if(NativeSeat.seated(player)&&!NativeSeat.allowedWhileSeated(operation.name)) throw error("SEATED","Body is sitting; call stand-up first");
        // A looping add-on animation ends when the body does anything else; talking and looking keep it going.
        if(!Set.of("send-chat","look-at","emote","set-appearance").contains(operation.name)) emotes.stopAnimation();
        if(operation.name.equals("emote")) {
            if(operation.args.has("player")&&!operation.args.has("source")) {
                ServerPlayer facing=findPlayer(string(operation.args,"player"));
                if(facing==null) throw error("PLAYER_NOT_VISIBLE","Named player is not within 32 blocks in this dimension");
                look(facing.getEyePosition());
            }
            if(emotes.begin(operation,player,now())) { player.stopInput();active=operation; }
            return;
        }
        if(operation.name.equals("set-appearance")) { operation.finish("succeeded","Appearance applied",BodyEmotes.setAppearance(operation.args,player,server)); return; }
        if(operation.name.equals("wake-up")) { operation.finish("succeeded","Body is awake",NativeSleep.wake(player)); return; }
        if(operation.name.equals("sleep-in-bed")) { beginSleep(operation); return; }
        if(operation.name.equals("stand-up")) {
            JsonObject result=NativeSeat.standUp(player);
            // Getting up on purpose ends the seated posture; a guard standing the body up for a fight does not.
            if(posture!=null&&posture.kind()==Posture.Kind.SEATED) clearPosture();
            operation.finish("succeeded","Body is standing",result); return;
        }
        if(operation.name.equals("sit")) { beginSit(operation); return; }
        if(survival.handles(operation.name)) { survival.begin(operation);return; }
        if(operation.name.equals("send-chat")) {
            String message=string(args,"message");
            if(message.length()>256||message.stripLeading().startsWith("/")||message.chars().anyMatch(c->c<32||c==127||c==167)) throw error("INVALID_ARGUMENT","Chat must be one ordinary message up to 256 characters");
            ServerChatEvent event=new ServerChatEvent(player,message,Component.literal(message));
            outgoingChatEvent=event;
            try { NeoForge.EVENT_BUS.post(event); }
            finally { outgoingChatEvent=null; }
            if(event.isCanceled()) throw error("FORBIDDEN","Server chat event cancelled message");
            if(!session.mayDrive(operation)) throw error("LEASE_LOST","Lease expired while chat event was processing");
            server.getPlayerList().broadcastSystemMessage(Component.literal("<"+config.username()+"> ").append(event.getMessage()),false);
            recordChat(config.username(),event.getMessage().getString());
            operation.finish("succeeded","Server broadcast message",null); return;
        }
        if(operation.name.equals("look-at")) { look(point(args)); operation.finish("succeeded","Server view rotated",null); return; }
        if(operation.name.equals("approach-container")||operation.name.equals("approach-player")||operation.name.equals("approach-resource")) { beginApproach(operation);return; }
        if(operation.name.equals("pickup-item")) {PickupItem pickup=PickupItem.create(operation,player,session,survival,resources);task=pickup;active=operation;pickup.tick();if(!operation.status.equals("running"))stop();return;}
        if(operation.name.equals("retreat-from-entity")){beginRetreat(operation);return;}
        if(operation.name.equals("pillar-up")){requireWalkable();task=NativePillar.begin(operation,player,session,survival);active=operation;return;}
        if(operation.name.equals("craft-item")||operation.name.equals("smelt-item")) {
            WorkstationTask station=WorkstationTask.create(operation,player,session);
            try{station.start();}
            catch(Protocol.Error e){station.stop();JsonObject result=station.detail();result.addProperty("code",e.code);operation.finish(e.code.equals("UNKNOWN")?"unknown":"failed",e.code+": "+e.getMessage(),result);return;}
            if(operation.status.equals("running")){task=station;active=operation;}
            return;
        }
        if(operation.name.equals("workstation-options")){operation.finish("succeeded","Workstation options",StationQuery.run(player,args,subjectRefs));return;}
        if(operation.name.equals("produce-item")||operation.name.equals("modify-item")) {
            StationJob job=operation.name.equals("produce-item")?new ProduceTask(operation,player,session):new ModifyTask(operation,player,session,subjectRefs);
            try{job.start();}
            catch(Protocol.Error e){job.stop();JsonObject result=job.detail();result.addProperty("code",e.code);operation.finish(e.code.equals("UNKNOWN")?"unknown":"failed",e.code+": "+e.getMessage(),result);return;}
            if(operation.status.equals("running")){task=job;active=operation;}
            return;
        }
        if(operation.name.equals("travel-to")){requireWalkable();task=new TravelTask(operation,player,session);active=operation;return;}
        if(operation.name.equals("build")) {
            BuildTask build=new BuildTask(operation,player,session);
            if(args.has("dryRun")&&bool(args,"dryRun")){operation.finish("succeeded","Build plan (nothing changed)",build.plan());return;}
            // Not requireWalkable: called again right after a TIMEOUT the body may still be in the air (jumped off a
            // roof, coming down a scaffold); the task waits for it to land before it walks.
            NativeNavigation.conditions(player);if(!connected())throw error("BLOCKED","Body is not connected in authorized survival state");
            build.start();
            if(operation.status.equals("running")){task=build;active=operation;}
            return;
        }
        if(operation.name.equals("tend-crops")||operation.name.equals("breed-animals")||operation.name.equals("hunt")) {
            Vec3 center=player.position();
            if(args.has("player")){ServerPlayer near=findPlayer(string(args,"player"));if(near==null)throw error("PLAYER_NOT_VISIBLE","Named player is not within 32 blocks in this dimension");center=near.position();}
            else if(args.has("center"))center=point(object(args,"center"));
            boolean survey=args.has("survey")&&bool(args,"survey");
            if(operation.name.equals("tend-crops")) {
                FarmTask farm=new FarmTask(operation,player,session,center);
                if(survey){operation.finish("succeeded","Field survey",farm.survey());return;}
                requireWalkable();farm.start();
                if(operation.status.equals("running")){task=farm;active=operation;}
            } else if(operation.name.equals("hunt")) {
                HuntTask hunt=new HuntTask(operation,player,session,center);
                if(survey){operation.finish("succeeded","Hunt survey",hunt.survey());return;}
                requireWalkable();hunt.start();
                if(operation.status.equals("running")){task=hunt;active=operation;}
            } else {
                BreedTask breed=new BreedTask(operation,player,session,center);
                if(survey){operation.finish("succeeded","Animal survey",breed.survey());return;}
                requireWalkable();breed.start();
                if(operation.status.equals("running")){task=breed;active=operation;}
            }
            return;
        }
        long timeout=(long)bounded(args,"timeoutMs",operation.name.equals("follow-player")?60_000:15_000,500,120_000);
        ServerPlayer followed=null;
        if(operation.name.equals("move-to-position")) {
            Vec3 target=point(args);
            if(!player.serverLevel().hasChunkAt(BlockPos.containing(target))) throw error("UNLOADED","Target chunk is not loaded; travel-to walks there leg by leg");
            if(target.distanceTo(player.position())>32) throw error("OUT_OF_REACH","move-to-position is limited to 32 blocks; travel-to walks further");
            bounded(args,"tolerance",0.7,0.25,3);
        } else {
            String name=string(args,"player"); bounded(args,"distance",2.5,1,8);
            followed=findPlayer(name);
            if(followed==null) throw error("INVALID_ARGUMENT","Target player is not within 32 blocks in this dimension");
        }
        requireWalkable();
        WalkTask walk=new WalkTask(operation,timeout,true);walk.followed=followed;
        task=walk;active=operation;
    }
    static boolean atomicAction(String name){return (CAPABILITIES.contains(name)||ItemInteractions.capabilities().contains(name))&&!Set.of("nearby-blocks","nearby-resources","companion-pickup","companion-mining","survival-state","assess-tool","navigation-3d","look-around","machine-status","guard-duty-fenced","guard-duty-tasks","gift-receipts","entity-equipment","host-notice","last-death","assess-armour","server-posture").contains(name);}
    @Override public boolean nativeWriteInProgress(){return SurvivalActions.nativeWriteInProgress(player);}
    void beforePhysics(BodyPlayer body) {
        if(body!=player) { body.stopInput(); return; }
        reconcile();
        if(lastDriveTick==server.getTickCount()){
            if(!dutyDrove&&!postureDrove&&(active==null||!session.mayDrive(active)))body.stopInput();return;
        }
        lastDriveTick=server.getTickCount();postureDrove=false;
        if(survival!=null) survival.tick();
        emotes.tick(now());
        // The guard first, then a running operation, then the posture (docs/server_body_protocol.md, 陪伴姿态).
        if(duty!=null&&tickDuty(body)) return;
        if(posture!=null&&tickPosture()) return;
        if(active==null) { body.stopInput(); idleGaze(body); return; }
        if(!session.mayDrive(active)) { stop(); return; }
        if(task!=null) { tickTask(task); return; }
        if(emotes.gesturing()){
            JsonObject result=emotes.gestureResult();
            if(emotes.tickGesture(body))finish("succeeded","Emote done",result);
            return;
        }
        // Every operation left running has a task or a gesture: nothing else could drive this one.
        finish("failed","Nothing drives this action any more");
    }
    /**
     * One tick of the task in the slot (docs/companion_state_design.md 8.3). A refusal or fault it throws ends the
     * operation in the shape the task declares (BodyTask.Failure); a task that finished its operation is stopped here.
     */
    private void tickTask(BodyTask current) {
        try { current.tick(); }
        catch(RuntimeException thrown) {
            BodyTask.End end=BodyTask.end(current,thrown,()->player==null?null:position(player.position()));
            if(end==null) throw thrown;
            finish(end.status(),end.summary(),end.result());
            return;
        }
        if(active!=null&&!active.status.equals("running"))stop();
    }
    /** Head movement only while nothing aims the body: no action and the posture standing still. */
    private void idleGaze(BodyPlayer body){
        if(now()<gazeHold||body.isSleeping()||survival!=null&&survival.busy()||nativeWriteInProgress())return;
        gaze.tick(body,speaker,spokeAt,now());
    }
    /**
     * A bounded walk that ends by itself (docs/companion_state_design.md 8.3): move-to-position, follow-player,
     * approach-container/-player/-resource, retreat-from-entity, sleep-in-bed and sit. It finishes its operation and
     * never throws: a refusal ends it as failed with the code and position, any other fault as a movement failure.
     */
    private final class WalkTask implements BodyTask {
        final ControlSession.Operation operation;
        final NativeNavigation navigation;
        long deadline;
        /** Fight time added to the deadline, at most the walk's own limit; none for a retreat. */
        final GuardDuty.Grace grace;
        ServerPlayer followed,recipient;
        Vec3 recipientStart,retreatOrigin;
        BlockPos bed,seat;
        net.minecraft.world.entity.LivingEntity threat;
        double threatDistance;
        WalkTask(ControlSession.Operation operation,long timeout,boolean graced) {
            this.operation=operation;navigation=new NativeNavigation(player,session,operation);
            deadline=now()+timeout;grace=graced?new GuardDuty.Grace(timeout):null;
        }
        @Override public Failure failure(){return null;}
        // approach-player is not here: it fails once the player moves, and a fight moves everyone; a retreat never stops.
        @Override public boolean interruptible(){return player.onGround()&&Set.of("follow-player","move-to-position","approach-container","approach-resource","sleep-in-bed","sit").contains(operation.name);}
        @Override public void resumeAfterGuard(long fightMs){navigation.reset();navigation.rebaseHealth();if(grace!=null)deadline+=grace.grant(fightMs);}
        @Override public void stop(){navigation.stop();}
        @Override public void tick() {
            try {
                if(operation.name.equals("approach-container")||operation.name.equals("approach-player")||operation.name.equals("approach-resource")) {tickApproach();return;}
                if(operation.name.equals("retreat-from-entity")){tickRetreat();return;}
                if(operation.name.equals("sleep-in-bed")){tickSleep();return;}
                if(operation.name.equals("sit")){tickSit();return;}
                if(now()>=deadline) { finish(operation.name.equals("follow-player")?"succeeded":"failed","Movement time limit reached"); return; }
                Vec3 target;double tolerance;
                if(operation.name.equals("follow-player")) {
                    ServerPlayer current=findPlayer(string(operation.args,"player"));
                    if(current==null||current!=followed)throw error("STALE_TARGET","Followed player left or changed identity/dimension");
                    target=current.position();tolerance=bounded(operation.args,"distance",2.5,1,8);
                } else {target=point(operation.args);tolerance=bounded(operation.args,"tolerance",0.7,0.25,3);}
                if(target.distanceTo(player.position())>32)throw error("OUT_OF_REACH","Target moved beyond navigation range");
                boolean arrived=navigation.tick(target,feet->feet.distanceTo(target)<=tolerance);
                if(arrived&&operation.name.equals("move-to-position"))finish("succeeded","Reached server-observed target");
            } catch(Protocol.Error e) { finish("failed",e.code+": "+e.getMessage(),obj("code",e.code,"position",position(player.position()))); }
            catch(RuntimeException e) { finish("failed","Movement failed: "+e.getClass().getSimpleName()); }
        }
        private void tickApproach() {
            if(now()>=deadline)throw error("TIMEOUT","Approach time limit reached");
            FlatApproach geometry=new FlatApproach(player);Vec3 destination;
            java.util.function.Predicate<Vec3> goal;
            CompanionMiningGuard miningGuard=null;
            if(operation.name.equals("approach-container")||operation.name.equals("approach-resource")) {
                ResourceTargets.Target resource=operation.name.equals("approach-resource")?resources.require(player,string(operation.args,"targetToken")):null;
                BlockPos pos=resource!=null?resource.position():targets.require(player,string(operation.args,"targetToken")).position();
                miningGuard=resource==null?null:resource.miningGuard();
                destination=Vec3.atCenterOf(pos);
                // A log may be reached through leaves (the gathering task breaks them before digging); ores and containers need a clear line.
                boolean log=resource!=null&&resource.miningGuard()==null&&ResourceCatalog.kind(resource.state())==ResourceCatalog.Kind.LOG;
                goal=log?feet->geometry.reachThroughLeaves(feet,pos):feet->geometry.containerReach(feet,pos);
            } else {
                ServerPlayer actual=findPlayer(string(operation.args,"player"));
                if(actual!=recipient)throw error("STALE_TARGET","Recipient entity changed or left local range/dimension");
                if(actual.position().distanceTo(recipientStart)>0.5)throw error("TARGET_MOVED","Recipient moved during bounded approach");
                destination=actual.position();goal=feet->geometry.playerReach(feet,actual,bounded(operation.args,"distance",1.3,1,1.5));
            }
            boolean arrived;
            if(miningGuard==null)arrived=navigation.tick(destination,goal);
            else {
                CompanionMiningGuard bound=miningGuard;
                try {arrived=navigation.tick(destination,goal,bound::allows);}
                catch(Protocol.Error failure){if(failure.code.equals("OUT_OF_REACH"))throw error("COMPANION_OUT_OF_RANGE","Mining approach left the live companion radius");throw failure;}
            }
            if(arrived)finish("succeeded","Reached verified interaction position",approachResult(operation,recipient));
        }
        private void tickSleep() {
            if(now()>=deadline)throw error("TIMEOUT","Did not reach the bed in time");
            var state=NativeSleep.requireFreeBed(player,bed);BlockPos at=bed;
            if(!NativeSleep.inReach(player.position(),at,state)&&!navigation.tick(Vec3.atCenterOf(at),feet->NativeSleep.inReach(feet,at,state)))return;
            player.stopInput();
            finish("succeeded","Asleep in bed",NativeSleep.lieDown(player,at));
        }
        private void tickSit() {
            if(now()>=deadline) throw error("TIMEOUT","Did not reach the seat in time");
            BlockPos at=seat;NativeSeat.requireFreeSeat(player,at);
            if(!NativeSeat.inReach(player.position(),at)&&!navigation.tick(Vec3.atCenterOf(at),feet->NativeSeat.inReach(feet,at)))return;
            player.stopInput();
            JsonObject result=NativeSeat.sitDown(player,at,ServerController.this::look,()->{});
            // Sitting becomes the posture: a follow or wait ends here, the guard stays (it keeps the revision of what it replaced).
            long revision=posture==null?0:posture.revision; clearPosture(); posture=Posture.seated(at,revision,postureView());
            finish("succeeded","Sitting on the seat",result);
        }
        private void tickRetreat() {
            if(now()>=deadline)throw error("TIMEOUT","Safe retreat time limit reached");
            var current=ThreatSense.lookup(player,string(operation.args,"entityId"),string(operation.args,"expectedDimension"));
            if(current!=threat)throw error("STALE_TARGET","Retreat threat identity changed");
            ThreatSense.requireEligible(player,current);
            Vec3 enemy=current.position(),away=retreatOrigin.subtract(enemy);double requested=bounded(operation.args,"distance",4,1.5,6);
            if(away.horizontalDistance()<0.001)away=new Vec3(1,0,0);
            Vec3 destination=retreatOrigin.add(new Vec3(away.x,0,away.z).normalize().scale(4));
            double wanted=Math.max(requested,threatDistance+1),currentDistance=player.position().distanceTo(enemy);
            java.util.function.Predicate<Vec3> allowed=feet->feet.subtract(retreatOrigin).horizontalDistance()<=4&&Math.abs(feet.y-retreatOrigin.y)<=2.5&&feet.distanceTo(enemy)>=currentDistance-0.3;
            if(navigation.tick(destination,feet->feet.distanceTo(enemy)>=wanted,allowed))
                finish("succeeded","Reached a verified safer retreat position",obj("entityId",current.getUUID().toString(),"position",position(player.position()),"distance",player.position().distanceTo(enemy),"requestedDistance",requested,"travelLimit",4));
        }
    }
    private void beginApproach(ControlSession.Operation operation) {
        requireWalkable();
        long timeout=(long)bounded(operation.args,"timeoutMs",15_000,500,120_000);
        BlockPos container=null;ServerPlayer recipient=null;
        if(operation.name.equals("approach-resource")) {
            container=resources.require(player,string(operation.args,"targetToken")).position();
            if(Vec3.atCenterOf(container).distanceTo(player.position())>16)throw error("OUT_OF_REACH","Resource approach is limited to sixteen blocks");
        } else if(operation.name.equals("approach-container")) {
            container=targets.require(player,string(operation.args,"targetToken")).position();
            if(Vec3.atCenterOf(container).distanceTo(player.position())>32) throw error("INVALID_ARGUMENT","Container approach limited to 32 blocks");
        } else {
            bounded(operation.args,"distance",1.3,1,1.5);
            recipient=findPlayer(string(operation.args,"player"));
            if(recipient==null) throw error("STALE_TARGET","Recipient left local range or dimension");
            if(operation.args.has("expectedEntityId")&&!recipient.getUUID().toString().equals(string(operation.args,"expectedEntityId"))) throw error("STALE_TARGET","Recipient entity identity changed");
        }
        WalkTask walk=new WalkTask(operation,timeout,true);
        walk.recipient=recipient;walk.recipientStart=recipient==null?null:recipient.position();
        task=walk;active=operation;
    }
    private JsonObject approachResult(ControlSession.Operation operation,ServerPlayer recipient) {
        JsonObject result=obj("position",position(player.position()));
        if(operation.name.equals("approach-container")||operation.name.equals("approach-resource")) result.addProperty("targetToken",string(operation.args,"targetToken"));
        else {result.addProperty("player",recipient.getGameProfile().getName());result.addProperty("entityId",recipient.getUUID().toString());}
        return result;
    }
    private void requireWalkable() {
        NativeNavigation.conditions(player);
        if(!connected())throw error("BLOCKED","Body is not connected in authorized survival state");
        if(!player.onGround()&&!player.isInWater())throw error("BLOCKED","Start navigation from supported ground or water");
    }
    /** Walk to the nearest free bed (around the named player, or the body) and lie down when vanilla's bed range is reached. */
    private void beginSleep(ControlSession.Operation operation) {
        NativeSleep.requireSleepable(player);
        Vec3 center=player.position();
        if(operation.args.has("player")) {
            ServerPlayer near=findPlayer(string(operation.args,"player"));
            if(near==null) throw error("PLAYER_NOT_VISIBLE","Named player is not within 32 blocks in this dimension");
            center=near.position();
        }
        BlockPos bed=NativeSleep.nearestFreeBed(player,center);
        if(bed==null) throw error("NO_BED","No free bed within 16 blocks in loaded chunks");
        if(Vec3.atCenterOf(bed).distanceTo(player.position())>32) throw error("OUT_OF_REACH","The bed is more than 32 blocks away");
        requireWalkable();
        WalkTask walk=new WalkTask(operation,(long)bounded(operation.args,"timeoutMs",30_000,500,120_000),true);walk.bed=bed;
        task=walk;active=operation;
    }
    /**
     * Walk to a free seat (the given block, or the nearest within 8 blocks) and sit like a player right-clicking it.
     * A seat is whatever an installed seat adapter names; with none installed there is nothing to sit on.
     */
    private void beginSit(ControlSession.Operation operation) {
        NativeSeat.requireCanSit(player);
        boolean has=operation.args.has("x")||operation.args.has("y")||operation.args.has("z");
        if(has&&!(operation.args.has("x")&&operation.args.has("y")&&operation.args.has("z"))) throw error("INVALID_ARGUMENT","x, y and z go together");
        if(NativeSeat.seated(player)) {
            if(has) throw error("ALREADY_SITTING","Body is already sitting; call stand-up before sitting somewhere else");
            operation.finish("succeeded","Body is already sitting",obj("sitting",true,"alreadySitting",true));return;
        }
        BlockPos seat;
        if(has) {
            seat=BlockPos.containing(point(operation.args));
            NativeSeat.requireFreeSeat(player,seat);
        } else {
            seat=NativeSeat.nearestFreeSeat(player,player.position());
            if(seat==null) throw error("NO_SEAT",ModAdapters.seatAdapters().isEmpty()?"No seat adapter is installed, so no block nearby is known to be a seat":"No free seat within "+NativeSeat.SEARCH_RADIUS+" blocks in loaded chunks");
        }
        if(Vec3.atCenterOf(seat).distanceTo(player.position())>32) throw error("OUT_OF_REACH","The seat is more than 32 blocks away");
        requireWalkable();
        WalkTask walk=new WalkTask(operation,(long)bounded(operation.args,"timeoutMs",30_000,500,120_000),true);walk.seat=seat;
        task=walk;active=operation;
    }
    private void beginRetreat(ControlSession.Operation operation) {
        requireWalkable();bounded(operation.args,"distance",4,1.5,6);
        var threat=ThreatSense.lookup(player,string(operation.args,"entityId"),string(operation.args,"expectedDimension"));
        ThreatSense.requireEligible(player,threat);
        double distance=threat.distanceTo(player);
        if(distance>8)throw error("OUT_OF_REACH","Retreat threat must start within eight blocks");
        WalkTask walk=new WalkTask(operation,(long)bounded(operation.args,"timeoutMs",3000,500,5000),false);
        walk.threat=threat;walk.threatDistance=distance;walk.retreatOrigin=player.position();
        task=walk;active=operation;
    }
    private ServerPlayer findPlayer(String name) {
        ServerPlayer target=server.getPlayerList().getPlayerByName(name);
        return target!=null&&target!=player&&target.isAlive()&&target.serverLevel()==player.serverLevel()&&target.distanceToSqr(player)<=32*32?target:null;
    }
    private void finish(String status,String summary) {
        finish(status,summary,obj("position",position(player.position())));
    }
    private void finish(String status,String summary,JsonObject result) {
        if(task instanceof WalkTask walk)result.add("navigation",walk.navigation.diagnostics());
        // A built-in gesture (or another KEEPS/HOLDS action) that ends normally leaves the posture driving: no 3-second pause.
        boolean quiet=active!=null&&posture!=null&&posture.endsQuietly(active.name);
        if(active!=null) active.finish(status,summary,result);
        stopBody(!quiet);
    }
    @Override public void stop() { stopBody(true); }
    /** Ends the running action. The posture waits RESUME_AFTER_MS before it drives again, unless the action ended normally and left it alone (finish). */
    private void stopBody(boolean postureTail) { if(duty!=null)duty.interrupt();dutyDrove=false;dutyPaused=null;active=null;emotes.cancelGesture(player);BodyTask ended=task;task=null;if(ended!=null)ended.stop(); if(posture!=null&&postureTail) posture.interrupt(); if(player!=null) player.stopInput();if(survival!=null) survival.stop(); }
    @Override public void abort(ControlSession.Operation operation) { if(active==operation) stop();else if(survival!=null) survival.abort(operation); }
    @Override public boolean leave() {
        if(player==null)return false;
        remove();return true;
    }
    void remove() {
        session.revokeCurrent("Server body removed");
        emotes.stopAnimation();
        BodyPlayer old=player; VirtualConnection oldSink=sink; player=null; sink=null;survival=null;
        if(old!=null) {
            old.stopInput();
            if(old.connection instanceof VirtualGameListener listener) listener.clearPendingMotion();
            if(server.getPlayerList().getPlayer(config.uuid())==old) old.connection.onDisconnect(new DisconnectionDetails(Component.literal("MCBOT server body removed")));
            else if(!old.isRemoved()) { old.serverLevel().removePlayerImmediately(old,Entity.RemovalReason.DISCARDED); old.getTextFilter().leave(); }
        }
        if(oldSink!=null) oldSink.closeSink();
        wasConnected=false; lastDimension=null;
    }
    void close() {try{remove();}finally{validationProtection.close();NeoForge.EVENT_BUS.unregister(foodFinishListener);NeoForge.EVENT_BUS.unregister(damageListener);NeoForge.EVENT_BUS.unregister(attackGuard);NeoForge.EVENT_BUS.unregister(incomingDamageGuard);NeoForge.EVENT_BUS.unregister(sweepGuard);NeoForge.EVENT_BUS.unregister(trampleGuard);NeoForge.EVENT_BUS.unregister(friendlyFireGuard);NeoForge.EVENT_BUS.unregister(projectileMark);NeoForge.EVENT_BUS.unregister(deathListener);NeoForge.EVENT_BUS.unregister(dropsListener);}}
    private void look(Vec3 target) {
        Vec3 delta=target.subtract(player.getEyePosition());
        float yaw=(float)Math.toDegrees(Math.atan2(-delta.x,delta.z));
        float pitch=(float)-Math.toDegrees(Math.atan2(delta.y,delta.horizontalDistance()));
        NativeSeat.aim(player,yaw,pitch); // sitting: only the head turns
    }
    private static long now() { return System.nanoTime()/1_000_000; }
    private static Vec3 point(JsonObject args) {
        number(args,"x"); number(args,"y"); number(args,"z");
        return new Vec3(bounded(args,"x",0,-29_999_000,29_999_000),bounded(args,"y",0,-2048,2048),bounded(args,"z",0,-29_999_000,29_999_000));
    }
    private static String loaderVersion() { String running=com.mcbot.servercontrol.api.McbotApi.modVersion("neoforge"); return running.isEmpty()?com.mcbot.servercontrol.api.McbotApi.NEOFORGE:running; }
    private static JsonObject position(Vec3 point) { return obj("x",point.x,"y",point.y,"z",point.z); }
    private static JsonObject item(int slot,ItemStack item) { return obj("slot",slot,"id",item.isEmpty()?"minecraft:air":BuiltInRegistries.ITEM.getKey(item.getItem()).toString(),"count",item.getCount()); }
}
