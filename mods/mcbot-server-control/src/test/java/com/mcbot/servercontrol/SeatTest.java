package com.mcbot.servercontrol;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/** Sitting rules as plain values: hand choice, what a sitting body may still do, the verdict after the click, reach. */
final class SeatTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static boolean near(float a,float b){return Math.abs(net.minecraft.util.Mth.wrapDegrees(a-b))<0.001f;}
    private static boolean[] hotbar(int... empty){boolean[] slots=new boolean[9];for(int slot:empty)slots[slot]=true;return slots;}
    static void run(){
        // The click must go out with an empty hand: a carpet (or anything) in the selected slot makes the body switch away from it.
        check(NativeSeat.handSlot(hotbar(3,5),3)==3,"an empty selected hand stays");
        check(NativeSeat.handSlot(hotbar(5,7),0)==5,"a held carpet or tool in the selected slot: the first empty slot is selected instead");
        check(NativeSeat.handSlot(hotbar(),4)==-1,"a full hotbar has no empty hand; the caller moves a stack aside");
        check(NativeSeat.handSlot(hotbar(0),-1)==0,"no selection yet still finds an empty slot");

        // Success is what the body rides, not the click.
        check(NativeSeat.verdict(true,true,true,false)==null,"riding the seat entity next to the seat is sitting");
        check("SIT_REFUSED".equals(NativeSeat.verdict(false,false,false,false)),"nothing rides the body after the click: the interaction was refused");
        check("SEAT_OCCUPIED".equals(NativeSeat.verdict(false,false,false,true)),"not riding and the seat is taken: occupied, not refused");
        check("UNKNOWN".equals(NativeSeat.verdict(true,false,false,false)),"riding something that is not a known seat entity is reported, not called sitting");
        check("WRONG_SEAT".equals(NativeSeat.verdict(true,true,false,false)),"riding a seat entity away from the requested seat is not success");

        // A sitting body talks, looks, handles its inventory and eats; everything that moves it needs stand-up first.
        for(String action:new String[]{"send-chat","look-at","emote","wake-up","sit","stand-up","select-slot","equip-item","eat-item","open-container","click-slot","close-container","swap-inventory","drop-item","set-appearance"})
            check(NativeSeat.allowedWhileSeated(action),action+" is allowed while sitting");
        for(String action:new String[]{"move-to-position","follow-player","approach-container","approach-player","approach-resource","pickup-item","dig-block","place-block","travel-to","build","hunt","tend-crops","breed-animals","craft-item","smelt-item","sleep-in-bed","pillar-up","use-bucket","use-item-on-block","defend-entity","retreat-from-entity"})
            check(!NativeSeat.allowedWhileSeated(action),action+" needs stand-up first");

        // Protection stays on while sitting; only a hostile creature close by gets the body up.
        check(NativeSeat.standForFight(true,true,true),"sitting with protection and a hostile close by: get up");
        check(!NativeSeat.standForFight(true,true,false)&&!NativeSeat.standForFight(true,false,true)&&!NativeSeat.standForFight(false,true,true),"no hostile, no protection, or not sitting: nothing happens");

        // Reach: next to the seat and about level with the feet.
        BlockPos seat=new BlockPos(10,64,10);
        check(NativeSeat.inReach(new Vec3(11.5,64,10.5),seat)&&NativeSeat.inReach(new Vec3(10.5,64,12.4),seat),"beside the seat is in reach");
        check(!NativeSeat.inReach(new Vec3(14.5,64,10.5),seat)&&!NativeSeat.inReach(new Vec3(10.5,67,10.5),seat)&&!NativeSeat.inReach(new Vec3(10.5,60,10.5),seat),"far away or on another level is not");

        // Sitting head: it turns toward the view, held to SIT_HEAD_YAW either side of the seat, the short way round (across ±180 too).
        check(near(NativeSeat.seatedHeadYaw(0,30),30),"inside the limit the head goes where it looks");
        check(near(NativeSeat.seatedHeadYaw(0,200),-NativeSeat.SIT_HEAD_YAW),"200 is 160 the short way: held to -105");
        check(near(NativeSeat.seatedHeadYaw(0,-NativeSeat.SIT_HEAD_YAW),-NativeSeat.SIT_HEAD_YAW),"exactly the limit stays");
        check(near(Math.abs(net.minecraft.util.Mth.wrapDegrees(NativeSeat.seatedHeadYaw(-90,90)+90)),NativeSeat.SIT_HEAD_YAW),"a view directly behind is held to exactly 105 off the seat");
        check(near(NativeSeat.seatedHeadYaw(170,-170),190)&&Math.abs(net.minecraft.util.Mth.wrapDegrees(NativeSeat.seatedHeadYaw(170,-170)-170))<=NativeSeat.SIT_HEAD_YAW,"across the 180 seam the short way is 20 degrees, not 340");
        // Standing bodies turn with their view, sitting bodies keep the seat (the aim entry itself needs a live player: not tested here).
        check(NativeSeat.bodyFollowsView(false)&&!NativeSeat.bodyFollowsView(true),"only a standing body turns its body with the view");

        // Real capabilities: both are actions that can be called, unlike declaration-only capabilities.
        check(ServerController.CAPABILITIES.contains("sit")&&ServerController.CAPABILITIES.contains("stand-up"),"sit and stand-up advertised");
        check(ServerController.atomicAction("sit")&&ServerController.atomicAction("stand-up"),"sit and stand-up are real actions");
        check(NativeSeat.actions().equals(java.util.List.of("sit","stand-up")),"the seat actions");
        System.out.println("SeatTest: "+checks+" checks passed");
    }
}
