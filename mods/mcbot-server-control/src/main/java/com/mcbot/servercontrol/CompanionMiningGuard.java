package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.phys.*;
import com.mcbot.servercontrol.mixin.ServerPlayerGameModeAccessor;
import static com.mcbot.servercontrol.Protocol.*;

/** One scan binds a live player instance; later approach/dig/pickup cannot rebind by name or UUID. */
final class CompanionMiningGuard {
    static final double PROTECTION_DISTANCE=2, PICKUP_SOURCE_DISTANCE=3;
    /** How far from the player an ore may be: as far as protection leaves them for a fight (GuardDuty.ENGAGE_RANGE), the same short detour. */
    static final int MIN_DISTANCE=3,MAX_DISTANCE=(int)GuardDuty.ENGAGE_RANGE;
    /** A mined drop pops and slides; it may rest past the radius while the body still reaches it from inside. */
    static final double DROP_REACH_MARGIN=1.5;
    record Player(Object identity,UUID uuid,Object dimension,Vec3 position,AABB bounds,boolean available) {}
    record Options(String player,UUID expected,int maxDistance) {}
    interface View {
        Object dimension();Vec3 bodyPosition();Player companion(String name);
        boolean miningConflict(BlockPos position);
    }
    private final View view;
    private final Options options;
    private final Player bound;
    CompanionMiningGuard(JsonObject args,View view) {
        this.view=view;options=options(args);bound=view.companion(options.player());current();
    }
    static Options options(JsonObject args) {
        String name=string(args,"player"),uuid=string(args,"expectedEntityId");
        if(!name.matches("[A-Za-z0-9_]{1,16}"))throw error("INVALID_ARGUMENT","companionMiningGuard.player must be a player name");
        UUID expected;
        try {expected=UUID.fromString(uuid);if(!expected.toString().equalsIgnoreCase(uuid))throw new IllegalArgumentException();}
        catch(IllegalArgumentException failure){throw error("INVALID_ARGUMENT","companionMiningGuard.expectedEntityId must be a complete UUID");}
        double distance=number(args,"maxDistance");
        if(distance!=Math.rint(distance)||distance<MIN_DISTANCE||distance>MAX_DISTANCE)throw error("INVALID_ARGUMENT","companionMiningGuard.maxDistance must be an integer "+MIN_DISTANCE+".."+MAX_DISTANCE);
        return new Options(name,expected,(int)distance);
    }
    private Player current() {
        Player actual=view.companion(options.player());
        if(bound==null||actual==null||!actual.available()||actual.identity()!=bound.identity()||!options.expected().equals(actual.uuid())||
            actual.dimension()!=bound.dimension()||actual.dimension()!=view.dimension())
            throw error("STALE_COMPANION","Mining companion left, died, changed instance or dimension");
        return actual;
    }
    Vec3 center(){return current().position();}
    int maxDistance(){return options.maxDistance();}
    double dropDistance(){return options.maxDistance()+DROP_REACH_MARGIN;}
    void validateBody() {
        Player actual=current();requireWithin(view.bodyPosition(),actual.position());
    }
    void validateTarget(BlockPos position) {
        Player actual=current();requireWithin(view.bodyPosition(),actual.position());requireWithin(Vec3.atCenterOf(position),actual.position());
        if(protectedBlock(position,actual.bounds()))throw error("COMPANION_PROTECTED","Ore cell is within the fixed two-block companion body/feet protection distance");
        if(view.miningConflict(position))throw error("COMPANION_MINING_CONFLICT","Another nearby player is actively mining this same ore cell");
    }
    void validatePickup(BlockPos source,Vec3 drop) {
        Player actual=current();requireWithin(view.bodyPosition(),actual.position());
        if(drop.distanceToSqr(actual.position())>dropDistance()*dropDistance())throw error("COMPANION_OUT_OF_RANGE","Drop left the live companion radius plus the fixed reach margin");
        if(drop.distanceToSqr(Vec3.atCenterOf(source))>PICKUP_SOURCE_DISTANCE*PICKUP_SOURCE_DISTANCE)
            throw error("COMPANION_OUT_OF_RANGE","Drop left the bounded source-ore neighbourhood; position does not prove drop ownership");
    }
    boolean allows(Vec3 point){return point.distanceToSqr(current().position())<=options.maxDistance()*options.maxDistance();}
    private void requireWithin(Vec3 point,Vec3 center) {
        if(point.distanceToSqr(center)>options.maxDistance()*options.maxDistance())throw error("COMPANION_OUT_OF_RANGE","Body or bound mining target left the live companion radius");
    }
    static boolean protectedBlock(BlockPos position,AABB player) {
        AABB cell=new AABB(position),bodyAndSole=new AABB(player.minX,player.minY-0.05,player.minZ,player.maxX,player.maxY,player.maxZ);
        return boxDistanceSquared(cell,bodyAndSole)<=PROTECTION_DISTANCE*PROTECTION_DISTANCE;
    }
    private static double boxDistanceSquared(AABB a,AABB b) {
        double x=Math.max(0,Math.max(a.minX-b.maxX,b.minX-a.maxX));
        double y=Math.max(0,Math.max(a.minY-b.maxY,b.minY-a.maxY));
        double z=Math.max(0,Math.max(a.minZ-b.maxZ,b.minZ-a.maxZ));
        return x*x+y*y+z*z;
    }
    static boolean miningSameCell(BlockPos target,boolean destroying,BlockPos destroyPos,boolean delayed,BlockPos delayedPos) {
        return destroying&&target.equals(destroyPos)||delayed&&target.equals(delayedPos);
    }
    static CompanionMiningGuard create(ServerPlayer body,JsonObject args) {
        return new CompanionMiningGuard(args,new View(){
            public Object dimension(){return body.serverLevel();}
            public Vec3 bodyPosition(){return body.position();}
            public Player companion(String name){
                ServerPlayer player=body.getServer().getPlayerList().getPlayerByName(name);
                return player==null?null:new Player(player,player.getUUID(),player.serverLevel(),player.position(),player.getBoundingBox(),
                    player!=body&&player.isAlive()&&!player.isRemoved()&&player.connection!=null&&player.connection.isAcceptingMessages());
            }
            public boolean miningConflict(BlockPos position){
                for(ServerPlayer player:body.serverLevel().players()) {
                    if(player==body)continue;
                    if(!(player.gameMode instanceof ServerPlayerGameModeAccessor mining))throw error("UNSUPPORTED","Native other-player mining state is not available");
                    if(miningSameCell(position,mining.mcbot$isDestroyingBlock(),mining.mcbot$destroyPos(),mining.mcbot$hasDelayedDestroy(),mining.mcbot$delayedDestroyPos()))return true;
                }
                return false;
            }
        });
    }
}
