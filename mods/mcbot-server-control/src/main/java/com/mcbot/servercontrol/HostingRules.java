package com.mcbot.servercontrol;

import java.nio.file.Path;
import java.util.UUID;
import static com.mcbot.servercontrol.Protocol.*;

/** Where the body may run: a dedicated server, or a single-player world opened to LAN (which never pauses). */
final class HostingRules {
    record Host(boolean dedicated,boolean published,boolean paused,boolean commandsForAll) {}
    static final String AUTO_WORLD="auto";
    static final int MAX_WORLD_ID=48;
    static final String SERVER_WORLD_PREFIX="srv-";
    private HostingRules() {}
    /** Checked before claim, respawn and act: a paused or un-published integrated server would freeze native actions. */
    static void requireRunnable(Host host) {
        if(!host.dedicated()&&!host.published())throw error("SINGLEPLAYER_NOT_LAN","Single-player world must be opened to LAN (Esc > Open to LAN) before the bot can be controlled");
        if(host.paused())throw error("GAME_PAUSED","Game is paused; native actions would not run");
    }
    /**
     * OP stays refused, except the blanket OP that "Open to LAN + Allow Cheats" grants every player.
     * That host has no spawn protection to bypass; an explicitly listed OP is still refused.
     */
    static boolean forbiddenOp(Host host,boolean op,boolean listedOp) {
        return op&&(listedOp||host.dedicated()||!host.commandsForAll());
    }
    /**
     * A new dedicated-server config gets its own fixed ID: dedicated save folders are almost always "world",
     * so "auto" would make every server share one world memory. scripts/webui-games.mjs writes the same form.
     */
    static String newServerWorldId() {
        return SERVER_WORLD_PREFIX+UUID.randomUUID().toString().substring(0,8);
    }
    /** "auto" uses the save folder, so single-player worlds sharing one instance config keep separate memories. */
    static String worldId(String configured,boolean dedicated,Path worldRoot) {
        if(!AUTO_WORLD.equals(configured))return configured;
        Path folder=worldRoot.toAbsolutePath().normalize().getFileName();
        StringBuilder name=new StringBuilder();
        (folder==null?"":folder.toString()).codePoints().limit(MAX_WORLD_ID).forEach(c->name.appendCodePoint(Character.isLetterOrDigit(c)||c=='-'||c=='_'?c:'_'));
        String id=name.isEmpty()?"world":name.toString();
        return dedicated?id:"sp-"+id;
    }
}
