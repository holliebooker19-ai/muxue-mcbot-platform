package com.mcbot.servercontrol;

import java.nio.file.Path;

/** Dedicated vs single-player (LAN) hosting rules, without launching Minecraft. */
final class HostingRulesTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}
    private static void errorCode(String code,Runnable action){checks++;try{action.run();throw new AssertionError("Expected "+code);}catch(Protocol.Error failure){if(!failure.code.equals(code))throw failure;}}
    private static HostingRules.Host host(boolean dedicated,boolean published,boolean paused,boolean cheats){return new HostingRules.Host(dedicated,published,paused,cheats);}
    static void run() {
        HostingRules.requireRunnable(host(true,true,false,false));check(true,"dedicated server is runnable");
        errorCode("SINGLEPLAYER_NOT_LAN",()->HostingRules.requireRunnable(host(false,false,false,false)));
        errorCode("SINGLEPLAYER_NOT_LAN",()->HostingRules.requireRunnable(host(false,false,true,false)));
        HostingRules.requireRunnable(host(false,true,false,false));check(true,"single-player opened to LAN is runnable");
        HostingRules.requireRunnable(host(false,true,false,true));check(true,"LAN with cheats is runnable");
        errorCode("GAME_PAUSED",()->HostingRules.requireRunnable(host(false,true,true,false)));

        check(!HostingRules.forbiddenOp(host(true,true,false,false),false,false),"non-OP body is allowed");
        check(HostingRules.forbiddenOp(host(true,true,false,false),true,true),"listed OP on a dedicated server stays refused");
        check(HostingRules.forbiddenOp(host(true,true,false,true),true,false),"dedicated server never takes the LAN-cheats exception");
        check(!HostingRules.forbiddenOp(host(false,true,false,true),true,false),"blanket OP from LAN + cheats is allowed");
        check(HostingRules.forbiddenOp(host(false,true,false,true),true,true),"explicitly listed OP stays refused even with LAN cheats");
        check(HostingRules.forbiddenOp(host(false,true,false,false),true,false),"OP from another source without LAN cheats stays refused");

        check(HostingRules.worldId("survival-1",false,Path.of("saves","New World")).equals("survival-1"),"configured world ID is kept");
        check(HostingRules.worldId("auto",true,Path.of("server","world")).equals("world"),"dedicated auto uses the level folder");
        check(HostingRules.worldId("auto",false,Path.of("saves","New World","."))
            .equals("sp-New_World"),"single-player auto uses the normalized save folder and replaces spaces");
        check(HostingRules.worldId("auto",false,Path.of("saves","我的世界-2")).equals("sp-我的世界-2"),"unicode letters, digits and dashes are kept");
        check(HostingRules.worldId("auto",false,Path.of("saves","a".repeat(60))).equals("sp-"+"a".repeat(HostingRules.MAX_WORLD_ID)),"long folder names are truncated");
        check(HostingRules.worldId("auto",false,Path.of("/").toAbsolutePath().getRoot()).equals("sp-world"),"a root path without a folder name falls back to world");
        String first=HostingRules.newServerWorldId(),second=HostingRules.newServerWorldId();
        check(first.matches("srv-[0-9a-f]{8}")&&!first.equals(second),"each new dedicated config gets its own srv- world ID");
        check(HostingRules.worldId(first,true,Path.of("server","world")).equals(first),"the generated ID is kept, not replaced by the level folder");
        System.out.println("HostingRulesTest: "+checks+" checks passed (LAN requirement, OP exception, auto and new server world ID)");
    }
}
