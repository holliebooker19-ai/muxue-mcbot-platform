package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.protocol.game.ServerboundSetCarriedItemPacket;
import net.minecraft.network.protocol.game.ServerboundUseItemOnPacket;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Pillar up one block the way a player does: jump in place and, once the feet clear the block they stood
 * in, place the selected full block there (a right-click on the top face of the floor), then land on it.
 * Refuses before any write without headroom, solid floor, a replaceable feet cell or a plain full block;
 * a missed placement window lands back where it started and fails with no world change.
 */
final class NativePillar implements BodyTask {
    /** A refusal or fault in tick ends the operation like this (BodyTask, docs/companion_state_design.md 8.3). */
    @Override public BodyTask.Failure failure(){return new BodyTask.Failure(JsonObject::new,true,null,false);}
    /** Never stepped aside for a fight: the body is in the air or on a block it just placed. */
    @Override public boolean interruptible(){return false;}
    @Override public void resumeAfterGuard(long fightMs){}
    /** Nothing of its own to release: the controller stops the body's input right after. */
    @Override public void stop(){}
    static final long TIMEOUT_MS=3000;
    private final ControlSession.Operation operation;
    private final BodyPlayer body;
    private final ControlSession session;
    private final SurvivalActions survival;
    private final BlockPos feet;
    private final int slot;
    private int before;
    private final Block block;
    private final String item;
    private final JsonObject components;
    private final long deadline;
    private boolean placed,leftGround;
    private int sequence;

    private NativePillar(ControlSession.Operation operation,BodyPlayer body,ControlSession session,SurvivalActions survival,BlockPos feet,int slot,ItemStack stack,Block block) {
        this.operation=operation;this.body=body;this.session=session;this.survival=survival;this.feet=feet;this.slot=slot;this.block=block;
        before=stack.getCount();item=BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();components=survival.components(stack);deadline=now()+TIMEOUT_MS;
    }
    private static long now(){return System.nanoTime()/1_000_000;}

    static NativePillar begin(ControlSession.Operation operation,BodyPlayer body,ControlSession session,SurvivalActions survival) {
        JsonObject args=operation.args;
        NativeNavigation.conditions(body);
        if(!body.onGround()||body.isInWater())throw error("BLOCKED","Pillar up from supported dry ground");
        int slot=SurvivalActions.integer(args,"slot");
        if(slot<0||slot>8)throw error("INVALID_ARGUMENT","slot must be a hotbar slot 0..8");
        ItemStack stack=body.getInventory().getItem(slot);
        if(!string(args,"expectedItem").equals(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString())||SurvivalActions.integer(args,"expectedCount")!=stack.getCount()||!object(args,"expectedComponents").equals(survival.components(stack)))
            throw error("STALE_ITEM","Item ID, count or components changed; observe again");
        if(stack.isEmpty()||!(stack.getItem() instanceof BlockItem blockItem))throw error("UNSUPPORTED","Pillar blocks must be ordinary block items");
        Block block=blockItem.getBlock();
        BlockPos feet=body.blockPosition();
        var level=body.serverLevel();
        if(!pillarBlock(block,level,feet))throw error("UNSUPPORTED","Pillar blocks must be plain full cubes without gravity, block entities or hazards");
        if(!level.isLoaded(feet.above(2))||!level.isLoaded(feet.below()))throw error("UNLOADED","Pillar cells are not loaded");
        BlockState floor=level.getBlockState(feet.below()),cell=level.getBlockState(feet);
        if(floor.getCollisionShape(level,feet.below()).isEmpty())throw error("BLOCKED","No solid floor under the feet to place against");
        if(!cell.getCollisionShape(level,feet).isEmpty()||!(cell.isAir()||cell.canBeReplaced())||!cell.getFluidState().isEmpty())throw error("BLOCKED","The feet cell cannot take a block");
        for(int h=1;h<=2;h++){
            BlockState above=level.getBlockState(feet.above(h));
            if(!above.getCollisionShape(level,feet.above(h)).isEmpty()||!above.getFluidState().isEmpty())throw error("BLOCKED","No headroom to jump and rise one block");
        }
        body.connection.handleSetCarriedItem(new ServerboundSetCarriedItemPacket(slot));
        body.setXRot(90);
        return new NativePillar(operation,body,session,survival,feet,slot,stack,block);
    }
    /** Plain solid cube: no falling blocks (sand, gravel), block entities or hazards such as magma. */
    static boolean pillarBlock(Block block,net.minecraft.world.level.BlockGetter level,BlockPos at) {
        BlockState state=block.defaultBlockState();
        return !(block instanceof FallingBlock)&&!state.hasBlockEntity()&&!FlatApproach.hazard(state)&&state.isCollisionShapeFullBlock(level,at);
    }
    /** One server tick; finishes the operation itself. */
    @Override public void tick() {
        if(!session.mayDrive(operation))throw error("LEASE_LOST","Control expired while pillaring");
        if(now()>=deadline){body.stopInput();throw error(placed?"UNKNOWN":"TIMEOUT","Pillar time limit reached");}
        double y=body.getY();
        if(placed){
            body.jumpInput(false);
            if(body.onGround())operation.finish("succeeded","Native pillar block placed and stood on",result());
            return;
        }
        ItemStack stack=body.getInventory().getItem(slot);
        if(body.getInventory().selected!=slot||stack.getCount()<before||!BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(item))throw error("STALE_ITEM","Selected pillar stack changed");
        // Native pickup may merge a drop of the same block into the stack mid-jump (a log chopped overhead): still the same stack.
        before=stack.getCount();
        if(body.onGround()&&!leftGround){body.jumpInput(true);return;}
        if(!body.onGround())leftGround=true;
        body.jumpInput(false);
        if(leftGround&&body.onGround()){operation.finish("failed","FORBIDDEN: Landed again before the pillar block could be placed",obj("code","FORBIDDEN","position",position(body.position())));return;}
        if(y<feet.getY()+1.0)return;
        // The feet now clear the cell: right-click the top face of the floor, as a player does mid-jump.
        BlockHitResult hit=new BlockHitResult(new Vec3(feet.getX()+0.5,feet.getY(),feet.getZ()+0.5),Direction.UP,feet.below(),false);
        body.connection.handleUseItemOn(new ServerboundUseItemOnPacket(InteractionHand.MAIN_HAND,hit,++sequence));
        BlockState now=body.serverLevel().getBlockState(feet);
        ItemStack after=body.getInventory().getItem(slot);
        if(now.is(block)&&after.getCount()==before-1)placed=true;
        else if(!now.isAir()&&!now.canBeReplaced()||after.getCount()!=before){body.stopInput();operation.finish("unknown","Pillar placement produced a different authoritative state; do not replay",result());}
    }
    private JsonObject result() {
        JsonObject block=obj("position",obj("x",feet.getX(),"y",feet.getY(),"z",feet.getZ()),"id",BuiltInRegistries.BLOCK.getKey(body.serverLevel().getBlockState(feet).getBlock()).toString());
        return obj("block",block,"position",position(body.position()),"consumedCount",before-body.getInventory().getItem(slot).getCount());
    }
    private static JsonObject position(Vec3 p){return obj("x",p.x,"y",p.y,"z",p.z);}
}
