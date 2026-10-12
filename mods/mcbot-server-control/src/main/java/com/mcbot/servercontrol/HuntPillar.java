package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import static com.mcbot.servercontrol.Protocol.*;
import static com.mcbot.servercontrol.NativeWorkstation.plain;

/**
 * The stand hunt fights from: a pillar of spare blocks beside the target, high enough that a melee mob's reach (its own
 * box widened sideways only, vanilla Mob.getAttackBoundingBox) passes under the body's feet; the pillar is dug back
 * afterwards. Rising is NativePillar one block at a time and digging is the dig-block action, each run as a child
 * operation of the hunt, so they take the same refusals and checks as the pillar tool.
 */
final class HuntPillar {
    /** Same ceiling as the build's scaffold: a taller mob is not stood over. */
    static final int MAX=BuildTask.MAX_SCAFFOLD;
    private record Step(BlockPos pos,Block block) {}
    private final BodyPlayer player;
    private final ControlSession session;
    private final SurvivalActions survival;
    private final String parent;
    private final List<Step> placed=new ArrayList<>();
    private ControlSession.Operation child;
    private NativePillar rising;
    private int childSerial;
    /** Down: the block being dug, and until when to wait for the fall onto the one below. */
    private Step digging;
    private long landBy;
    private Item item;

    HuntPillar(BodyPlayer player,ControlSession session,SurvivalActions survival,String parentOperation) {
        this.player=player;this.session=session;this.survival=survival;this.parent=parentOperation;
    }
    private static long now(){return System.nanoTime()/1_000_000;}

    /**
     * How many blocks to stand on so the feet clear the target's box top: a melee mob reaches sideways but not up, and the
     * attack box has to overlap the body's, so feet at the top (not below it) are out of reach. Zero or less: already above.
     */
    static int levels(double feetY,double targetTop){return (int)Math.ceil(targetTop-feetY);}
    int height(){return placed.size();}
    boolean busy(){return child!=null||digging!=null;}

    // ---------- the block to stand on ----------
    /** A spare plain full block to stand on, breakable by hand or a carried tool, softest first; null when there are fewer than `count` of any. */
    Item choose(int count) {
        Inventory inv=player.getInventory();Item best=null;float hardness=Float.MAX_VALUE;
        for(int i=0;i<36;i++) {
            ItemStack s=inv.getItem(i);
            if(!plain(s)||!(s.getItem() instanceof BlockItem b)||!NativePillar.pillarBlock(b.getBlock(),player.serverLevel(),player.blockPosition()))continue;
            BlockState state=b.getBlock().defaultBlockState();
            if(state.requiresCorrectToolForDrops()&&!hasToolFor(state))continue;
            if(stock(s.getItem())<count)continue;
            float h=state.getDestroySpeed(player.serverLevel(),player.blockPosition());if(h>=0&&h<hardness){hardness=h;best=s.getItem();}
        }
        return best;
    }
    private int stock(Item wanted){Inventory inv=player.getInventory();int n=0;for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.is(wanted))n+=s.getCount();}return n;}
    private boolean hasToolFor(BlockState state){Inventory inv=player.getInventory();for(int i=0;i<36;i++)if(inv.getItem(i).isCorrectToolForDrops(state))return true;return false;}
    /** What a refusal to hunt says when the pack cannot give `count` blocks. */
    String lack(int count){return "needs "+count+" plain full blocks of one kind to stand on (dirt, cobblestone, planks...); the pack has at most "+bestStock()+" of any";}
    private int bestStock(){Inventory inv=player.getInventory();int best=0;for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(plain(s)&&s.getItem() instanceof BlockItem b&&NativePillar.pillarBlock(b.getBlock(),player.serverLevel(),player.blockPosition()))best=Math.max(best,stock(s.getItem()));}return best;}

    // ---------- up ----------
    /** Begin rising `want` blocks. Throws what NativePillar refuses with (a ceiling, no floor, no blocks). */
    void startRise(int want) {
        item=choose(want);
        if(item==null)throw error("NO_BLOCKS",lack(want));
        placed.clear();
    }
    /** One tick of rising to `want` blocks; true once the body stands on the last. Throws Protocol.Error when a block fails. */
    boolean rise(int want) {
        if(child!=null) {
            rising.tick();
            if(child.status.equals("running"))return false;
            ControlSession.Operation done=child;child=null;rising=null;
            if(!done.status.equals("succeeded")) {
                String code=done.result instanceof JsonObject r&&r.has("code")?r.get("code").getAsString():done.status.equals("unknown")?"UNKNOWN":"BLOCKED";
                throw error(code,done.summary);
            }
            JsonObject block=done.result.getAsJsonObject().getAsJsonObject("block"),at=block.getAsJsonObject("position");
            placed.add(new Step(new BlockPos(at.get("x").getAsInt(),at.get("y").getAsInt(),at.get("z").getAsInt()),BuiltInRegistries.BLOCK.get(net.minecraft.resources.ResourceLocation.parse(block.get("id").getAsString()))));
        }
        if(placed.size()>=want)return true;
        int slot=HuntTask.hotbarWith(player,s->plain(s)&&s.is(item));
        if(slot<0)throw error("NO_BLOCKS","The blocks to stand on ran out after "+placed.size());
        ItemStack stack=player.getInventory().getItem(slot);
        JsonObject args=obj("slot",slot,"expectedItem",BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(),"expectedCount",stack.getCount(),"expectedComponents",survival.components(stack));
        child=new ControlSession.Operation(parent+"/pillar-"+(++childSerial),session.sessionId(),session.generation(),"pillar-up",args);
        rising=NativePillar.begin(child,player,session,survival);
        return false;
    }

    // ---------- down ----------
    /**
     * One tick of coming down: dig the top block under the feet, wait for the fall, repeat. True when none is left, or when
     * the body is not on the top any more (pushed off, block changed): what is left standing is counted by height().
     */
    boolean descend() {
        if(digging!=null) {
            if(child!=null) {
                if(child.status.equals("running"))return false;
                boolean ok=child.status.equals("succeeded");child=null;
                if(!ok)return give();
                landBy=now()+NativePillar.TIMEOUT_MS;
            }
            if(player.onGround()&&player.blockPosition().getY()==digging.pos().getY()) {placed.removeLast();digging=null;}
            else if(now()>landBy)return give();
            else return false;
        }
        if(placed.isEmpty())return true;
        Step top=placed.getLast();
        BlockState state=player.serverLevel().getBlockState(top.pos());
        if(!player.onGround()||!player.blockPosition().equals(top.pos().above())||!state.is(top.block()))return give();
        equipFor(state);
        JsonObject args=obj("x",top.pos().getX(),"y",top.pos().getY(),"z",top.pos().getZ(),"expectedBlock",BuiltInRegistries.BLOCK.getKey(top.block()).toString(),"expectedProperties",SurvivalActions.properties(state));
        child=new ControlSession.Operation(parent+"/dig-"+(++childSerial),session.sessionId(),session.generation(),"dig-block",args);
        digging=top;
        try{survival.begin(child);}catch(Protocol.Error refused){child=null;return give();}
        return false;
    }
    /** Stop coming down with the rest standing. */
    private boolean give(){child=null;digging=null;return true;}
    /** The fastest tool in the pack for this block, moved into the hotbar when it is not there; the hand stays when nothing digs it faster. */
    private void equipFor(BlockState state) {
        Inventory inv=player.getInventory();int best=-1;float speed=1;
        for(int i=0;i<36;i++){ItemStack s=inv.getItem(i);if(s.isEmpty()||state.requiresCorrectToolForDrops()&&!s.isCorrectToolForDrops(state))continue;float v=s.getDestroySpeed(state);if(v>speed){speed=v;best=i;}}
        if(best>=0)HuntTask.select(player,best);
    }
    /** Hands the body back: an operation still digging is aborted by the controller's stop. */
    void forget(){child=null;rising=null;digging=null;}
}
