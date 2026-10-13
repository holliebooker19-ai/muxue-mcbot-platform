package com.mcbot.addon.ironfurnaces;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * MCBOT add-on for Iron Furnaces. Registers the iron furnace container adapter with MCBOT; it reports itself as
 * installed only when Iron Furnaces 4.3.2 is present, so the add-on is harmless on servers without it.
 */
@Mod("mcbot_iron_furnaces")
public final class McbotIronFurnaces {
    /** Usage note for the agent, sent in hello.hints while the adapter is installed (only what IronFurnaceAdapterTest and the server smoke cover). */
    static final String HINT = "Iron Furnaces: only the plain iron furnace (ironfurnaces:iron_furnace) is supported; gold, diamond and other tiers are refused. "
        + "Use it like a vanilla furnace: discover-containers, container-list, container-withdraw for the output; container-menu (open, read, click, close) to put input and fuel in their slots. "
        + "Only an unlit furnace in plain furnace mode opens; while it is burning, or set to another type, factory, generator or augment view, it is refused, so come back when it has stopped. "
        + "smelt-item does not use it.";

    public McbotIronFurnaces() {
        McbotApi.registerContainer(IronFurnaceAdapter.INSTANCE);
        McbotApi.registerHint("ironfurnaces:hint", HINT);
    }
}
