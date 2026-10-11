package com.mcbot.servercontrol;

import java.util.Set;

/** The interrupt window's own rules (docs/companion_state_design.md 8.4): when it opens, what runs in it, when it closes by itself. */
final class TaskInterruptTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    static void run() {
        opening();
        lifetime();
        System.out.println("TaskInterruptTest: "+checks+" checks passed");
    }
    private static void opening() {
        check(TaskInterrupt.refusal(false,true,false,false)==null,"an idle body opens a window");
        check(TaskInterrupt.refusal(false,true,true,true)==null,"a task that may pause now opens a window");
        check(TaskInterrupt.refusal(false,true,true,false)!=null,"a task that cannot pause now (scaffold, mid-dig, station) does not");
        check(TaskInterrupt.refusal(false,false,false,false)!=null,"eating, digging or an open menu holds the body even with nothing running");
        check(TaskInterrupt.refusal(true,true,true,true).contains("guard"),"never while the guard drives the body");
        check(TaskInterrupt.STEPS.equals(Set.of("select-slot","swap-inventory","eat-item","defend-entity","retreat-from-entity")),"the steps are what eating and defense send");
        check(TaskInterrupt.REASONS.equals(Set.of("eat","defend")),"a window is for eating or defense");
    }
    private static void lifetime() {
        TaskInterrupt window=new TaskInterrupt("eat",null,null,1000);
        check(!window.expired(false,1000+ControlSession.TTL_MS-1),"no step yet, but within the lease time");
        check(!window.expired(true,5000)&&!window.expired(false,5000+ControlSession.TTL_MS-1),"a running step keeps it open, counted from the last tick it ran");
        check(window.expired(false,5000+ControlSession.TTL_MS),"no step for the lease time closes it");
        check(window.pausedMs(4000)==3000&&window.pausedMs(500)==0,"paused time counts from opening");
        // The paused time comes out of the task's one Grace, the same as the guard's fights: at most its own limit in all.
        GuardDuty.Grace grace=new GuardDuty.Grace(10_000);
        check(grace.grant(6000)==6000&&grace.grant(window.pausedMs(7000))==4000&&grace.grant(1000)==0,"fights and pauses share one budget");
    }
}
