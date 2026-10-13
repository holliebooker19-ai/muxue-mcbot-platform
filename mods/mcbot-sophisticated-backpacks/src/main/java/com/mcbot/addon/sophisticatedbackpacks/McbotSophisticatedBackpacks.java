package com.mcbot.addon.sophisticatedbackpacks;

import com.mcbot.servercontrol.api.McbotApi;
import net.neoforged.fml.common.Mod;

/**
 * Example MCBOT add-on for Sophisticated Backpacks: opening a held backpack, picking a placed one up, placed backpacks as
 * containers, and pickup upgrade accounting. Everything reports itself as installed only with Sophisticated Backpacks 3.25.77 and Sophisticated
 * Core 1.4.86, so the add-on is harmless on servers without them.
 */
@Mod("mcbot_sophisticated_backpacks")
public final class McbotSophisticatedBackpacks {
    public McbotSophisticatedBackpacks() {
        McbotApi.registerContainer(BackpackContainerAdapter.INSTANCE);
        McbotApi.registerInteraction(OpenBackpack.INSTANCE);
        McbotApi.registerInteraction(PickupBackpack.INSTANCE);
        McbotApi.registerPickupSink(BackpackPickupSink.INSTANCE);
        McbotApi.registerHint("sophisticatedbackpacks:hint", HINT);
    }

    /** Usage note for the agent, sent in hello.hints while the adapter is installed (what BackpackRulesTest and the backpack/equip smokes cover). */
    static final String HINT = "Sophisticated Backpacks: a backpack in the hotbar opens with use-item backpack/open; then container-menu read, click to move items, close. "
        + "A placed backpack is a container: discover-containers, container-list, container-withdraw, or container-menu open. "
        + "To wear a placed one: interact-block backpack/take with emptyHand picks it up with its contents, then equip-item; it takes the chestplate slot, so tell the player first. "
        + "A backpack with any upgrade other than pickup is refused (UNSUPPORTED). Items a pickup upgrade takes are listed in storedIn. Putting a backpack down is not supported.";
}
