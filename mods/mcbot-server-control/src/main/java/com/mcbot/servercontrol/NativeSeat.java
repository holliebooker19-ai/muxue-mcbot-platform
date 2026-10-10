package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import com.mcbot.servercontrol.api.SeatAdapter;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundContainerClosePacket;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.inventory.ClickType;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Sitting on a mod's chair or stool the way a player does: a right-click on the seat block with an empty hand, after
 * which the mod puts the body on its seat entity (a vehicle). Vanilla has no seats, so what counts as one comes only from
 * installed {@link SeatAdapter}s ({@link ModAdapters#seat}). Success is what the body is observed to ride, never the click.
 * Getting up is the vanilla dismount, {@code stopRiding}.
 */
final class NativeSeat {
    static final int SEARCH_RADIUS=8,VERTICAL_RADIUS=3;
    /**
     * How far a sitting head may turn either side of the seat's facing. Vanilla does not limit a passenger's view on a plain
     * entity (Entity.onPassengerTurned is empty in 1.21.1, and SitEntity overrides nothing). This value is borrowed from
     * Boat.clampRotation, which holds a passenger to ±105 degrees of the boat's yaw (decompiled NeoForge 1.21.1 Boat.java).
     */
    static final float SIT_HEAD_YAW=105;
    /** What a body that sits can still do: talk, look, gesture, handle its own inventory and eat. Anything that moves it must stand up first. */
    private static final Set<String> WHILE_SEATED=Set.of("send-chat","look-at","emote","set-appearance","wake-up","sit","stand-up","select-slot","equip-item","swap-inventory","eat-item","drop-item","open-container","click-slot","close-container");
    private static int sequence;
    private NativeSeat() {}

    /** Whether the body is riding the seat entity of an installed seat adapter (a boat or a horse is not sitting). */
    static boolean seated(ServerPlayer bot) {
        return bot.isPassenger()&&ModAdapters.seatEntity(bot.getVehicle());
    }
    /** Rule for begin(): an action that is not in the list moves or occupies the body, so it is refused until stand-up. */
    static boolean allowedWhileSeated(String action) {return WHILE_SEATED.contains(action);}
    /**
     * Protection keeps its duty while seated; a hostile creature close by is the only thing that makes the body get up.
     * The seated posture walks it back and sits it down afterwards ({@link Posture}).
     */
    static boolean standForFight(boolean seated,boolean dutyHeld,boolean guardWouldFight) {return seated&&dutyHeld&&guardWouldFight;}

    /** The facing of the seat: KC sets the SitEntity's yaw from the chair's or stool's FACING when it spawns it, and never changes it. */
    static float seatYaw(ServerPlayer bot) {return bot.getVehicle().getYRot();}
    /** Head yaw for a sitting body: the wanted yaw, held to SIT_HEAD_YAW either side of the seat, the short way round. */
    static float seatedHeadYaw(float seatYaw,float wantedYaw) {return seatYaw+Mth.clamp(Mth.wrapDegrees(wantedYaw-seatYaw),-SIT_HEAD_YAW,SIT_HEAD_YAW);}
    /** Only a standing body turns its body with its view; a sitting body keeps the seat's facing. */
    static boolean bodyFollowsView(boolean seated) {return !seated;}
    /**
     * The one way a body turns toward a view (look-at, idle gaze, emote gestures). Standing: body, head and pitch go to the view.
     * Sitting: only the head turns, held by seatedHeadYaw; the body and its yaw stay on the seat.
     */
    static void aim(ServerPlayer bot,float yaw,float pitch) {
        if(bodyFollowsView(seated(bot))) {bot.setYRot(yaw);bot.setYBodyRot(yaw);bot.setYHeadRot(yaw);bot.setXRot(pitch);return;}
        bot.setYHeadRot(seatedHeadYaw(seatYaw(bot),yaw));bot.setXRot(pitch);
    }

    /** The hotbar slot to click with: the selected one when it is empty, else the first empty one, else -1. */
    static int handSlot(boolean[] hotbarEmpty,int selected) {
        if(selected>=0&&selected<hotbarEmpty.length&&hotbarEmpty[selected]) return selected;
        for(int i=0;i<hotbarEmpty.length;i++) if(hotbarEmpty[i]) return i;
        return -1;
    }
    /** Null when the body sits where it meant to; otherwise the failure code. */
    static String verdict(boolean riding,boolean seatEntity,boolean nearSeat,boolean seatTaken) {
        if(riding&&seatEntity&&nearSeat) return null;
        if(riding&&!seatEntity) return "UNKNOWN";
        if(riding) return "WRONG_SEAT";
        return seatTaken?"SEAT_OCCUPIED":"SIT_REFUSED";
    }
    /** Walk until the seat is within an arm's length and about level with the feet. */
    static boolean inReach(Vec3 feet,BlockPos seat) {
        Vec3 bottom=Vec3.atBottomCenterOf(seat);
        return Math.abs(feet.x-bottom.x)<=2.0&&Math.abs(feet.z-bottom.z)<=2.0&&feet.y-bottom.y<=1.0&&bottom.y-feet.y<=1.5;
    }

    /** Refuse before walking anywhere: anything the sit would refuse at the seat anyway. */
    static void requireCanSit(ServerPlayer bot) {
        if(bot.isSleeping()) throw error("SLEEPING","Body is asleep; call wake-up first");
        if(bot.isPassenger()&&!seated(bot)) throw error("BUSY","Body is riding something that is not a seat");
        if(bot.containerMenu!=bot.inventoryMenu) throw error("BUSY","Close the container before sitting down");
    }
    /** The adapter for the seat block, or a precise error: the block changed, is not a seat, or is taken. */
    static SeatAdapter requireFreeSeat(ServerPlayer bot,BlockPos position) {
        if(!bot.serverLevel().hasChunkAt(position)) throw error("STALE_TARGET","Seat chunk is no longer loaded");
        BlockState state=bot.serverLevel().getBlockState(position);
        SeatAdapter adapter=ModAdapters.seat(state);
        if(adapter==null) throw error(ModAdapters.seatAdapters().isEmpty()?"NO_SEAT":"STALE_TARGET",ModAdapters.seatAdapters().isEmpty()?"No seat adapter is installed, so no block here is known to be a seat":"That block is not a seat (any more)");
        if(occupied(adapter,bot,position)) throw error("SEAT_OCCUPIED","Someone is already sitting there");
        return adapter;
    }
    private static boolean occupied(SeatAdapter adapter,ServerPlayer bot,BlockPos position) {
        try { return adapter.occupied(bot.serverLevel(),position); } catch(RuntimeException | LinkageError broken) { return true; }
    }
    /** The nearest free seat around the centre, loaded chunks only; null when there is none. */
    static BlockPos nearestFreeSeat(ServerPlayer bot,Vec3 center) {
        if(ModAdapters.seatAdapters().isEmpty()) return null;
        BlockPos origin=BlockPos.containing(center),best=null;double bestDistance=Double.MAX_VALUE;
        for(int x=-SEARCH_RADIUS;x<=SEARCH_RADIUS;x++) for(int z=-SEARCH_RADIUS;z<=SEARCH_RADIUS;z++) {
            if(x*x+z*z>SEARCH_RADIUS*SEARCH_RADIUS) continue;
            for(int y=-VERTICAL_RADIUS;y<=VERTICAL_RADIUS;y++) {
                BlockPos pos=origin.offset(x,y,z);
                if(bot.serverLevel().isOutsideBuildHeight(pos)) continue;
                var chunk=bot.serverLevel().getChunkSource().getChunkNow(pos.getX()>>4,pos.getZ()>>4);
                if(chunk==null) continue;
                SeatAdapter adapter=ModAdapters.seat(chunk.getBlockState(pos));
                if(adapter==null||occupied(adapter,bot,pos)) continue;
                double distance=Vec3.atCenterOf(pos).distanceToSqr(center);
                if(distance<bestDistance) {best=pos.immutable();bestDistance=distance;}
            }
        }
        return best;
    }

    /**
     * Sends the player's right-click on the seat with an empty hand and reports what the body then rides.
     * {@code look} turns the body toward a point; {@code nativeSent} marks that a native write went out.
     */
    static JsonObject sitDown(ServerPlayer bot,BlockPos position,Consumer<Vec3> look,Runnable nativeSent) {
        SeatAdapter adapter=requireFreeSeat(bot,position);
        BlockHitResult hit=hit(bot,position);
        int previous=bot.getInventory().selected;
        int slot=handSlot(emptyHotbar(bot),previous);
        JsonObject moved=null;
        if(slot<0) {
            int room=-1;for(int i=9;i<36;i++) if(bot.getInventory().getItem(i).isEmpty()) {room=i;break;}
            if(room<0) throw error("EMPTY_HAND_REQUIRED","An empty hotbar slot is needed so the click cannot use or change an item, and the inventory is full");
            if(!bot.inventoryMenu.getCarried().isEmpty()) throw error("BUSY","The cursor holds an item");
            int free=previous==8?7:8;ItemStack stack=bot.getInventory().getItem(free).copy();
            nativeSent.run();
            NativeWorkstation.click(bot,bot.inventoryMenu,NativeWorkstation.menuSlot(bot.inventoryMenu,bot.getInventory(),room),free,ClickType.SWAP);
            if(!bot.getInventory().getItem(free).isEmpty()||!ItemStack.matches(bot.getInventory().getItem(room),stack)) throw error("UNKNOWN","Could not move a hotbar stack aside to free a hand");
            slot=free;moved=obj("item",BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),"count",stack.getCount(),"fromSlot",free,"toSlot",room);
        }
        look.accept(hit.getLocation());
        nativeSent.run();
        if(bot.getInventory().selected!=slot) bot.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot));
        try {
            // The stool declines a sneaking player (isSecondaryUseActive); the body clicks standing up straight.
            bot.setShiftKeyDown(false);
            if(!bot.getMainHandItem().isEmpty()) throw error("EMPTY_HAND_REQUIRED","The main hand is not empty after selecting the slot");
            bot.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        } finally {
            if(bot.getInventory().selected!=previous) bot.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(previous));
        }
        // A menu the click opened is not ours to keep.
        if(bot.containerMenu!=bot.inventoryMenu) bot.connection.handleContainerClose(new ServerboundContainerClosePacket(bot.containerMenu.containerId));
        Entity vehicle=bot.getVehicle();
        boolean seatEntity=bot.isPassenger()&&ModAdapters.seatEntity(vehicle);
        boolean near=seatEntity&&vehicle.position().distanceToSqr(Vec3.atCenterOf(position))<=2.25;
        String code=verdict(bot.isPassenger(),seatEntity,near,occupied(adapter,bot,position));
        if(code!=null) {
            throw switch(code) {
                case "SEAT_OCCUPIED" -> error(code,"Someone sat there first");
                case "WRONG_SEAT" -> error(code,"The body now sits on a different seat than the one requested; call stand-up and look again");
                case "UNKNOWN" -> error(code,"The click put the body on something that is not a known seat; call stand-up if it is still riding");
                default -> error(code,"The game did not seat the body (nothing is riding it); the seat may be blocked or protected");
            };
        }
        // Sitting: the body takes the seat's facing, so it matches the chair whatever the click turned it toward.
        float facing=vehicle.getYRot();bot.setYRot(facing);bot.setYBodyRot(facing);bot.setYHeadRot(facing);
        JsonObject result=obj("seat",obj("x",position.getX(),"y",position.getY(),"z",position.getZ()),"id",BuiltInRegistries.BLOCK.getKey(bot.serverLevel().getBlockState(position).getBlock()).toString(),
            "vehicle",BuiltInRegistries.ENTITY_TYPE.getKey(vehicle.getType()).toString(),"sitting",true,"selectedSlot",bot.getInventory().selected);
        if(moved!=null) result.add("movedAside",moved);
        return result;
    }
    private static boolean[] emptyHotbar(ServerPlayer bot) {
        boolean[] empty=new boolean[9];
        for(int i=0;i<9;i++) empty[i]=bot.getInventory().getItem(i).isEmpty();
        return empty;
    }
    /** The outline of the seat as the body sees it from its eyes; a wall or distance in between is an error, as for any player. */
    private static BlockHitResult hit(ServerPlayer bot,BlockPos position) {
        var shape=bot.serverLevel().getBlockState(position).getShape(bot.serverLevel(),position,net.minecraft.world.phys.shapes.CollisionContext.of(bot));
        Vec3 destination=shape.isEmpty()?Vec3.atCenterOf(position):shape.bounds().move(position).getCenter();
        BlockHitResult hit=bot.serverLevel().clip(new ClipContext(bot.getEyePosition(),destination,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,bot));
        if(hit.getType()!=HitResult.Type.BLOCK||!hit.getBlockPos().equals(position)) throw error("NO_LINE_OF_SIGHT","The seat is obstructed");
        if(bot.getEyePosition().distanceTo(hit.getLocation())>bot.blockInteractionRange()) throw error("OUT_OF_REACH","The seat is too far away");
        return hit;
    }

    /** Vanilla dismount. Already standing succeeds; riding anything that is not a seat is left alone. */
    static JsonObject standUp(ServerPlayer bot) {
        boolean was=seated(bot);
        if(!was&&bot.isPassenger()) throw error("NOT_SITTING","Body is riding something that is not a seat");
        if(was) {
            bot.stopRiding();
            if(bot.isPassenger()) throw error("UNKNOWN","The body is still riding after stand-up");
        }
        return obj("wasSitting",was,"sitting",false);
    }
    /** Names for the capability check in tests. */
    static List<String> actions() {return List.of("sit","stand-up");}
}
