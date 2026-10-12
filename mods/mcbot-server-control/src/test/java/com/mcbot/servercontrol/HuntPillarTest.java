package com.mcbot.servercontrol;

import java.util.UUID;

/**
 * hunt's pillar stand without a game: which iron golem a hunt may be asked to kill (a village's own, never a player's or a
 * named one), the one swing the friendly-fire cancel lets through, and how high to stand over a target. Entities cannot be
 * built here (the registries need a NeoForge-loaded game), so the checks run on the decisions the entity checks are built from.
 */
final class HuntPillarTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    static void run() {
        // Height: the feet must reach the top of the target's box (reach is sideways only, strict overlap), never below it.
        check(HuntPillar.levels(64,64+2.7f)==3,"An iron golem (2.7 tall) on the same ground: three blocks");
        check(HuntPillar.levels(64,64+1.95f)==2,"A zombie (1.95 tall): two blocks");
        check(HuntPillar.levels(64,66)==2,"Feet exactly at the box top are already out of reach: no extra block");
        check(HuntPillar.levels(64,66.0001)==3,"A hair above a whole block needs the next one");
        check(HuntPillar.levels(64,61+2.7f)<=0&&HuntPillar.levels(70,66.7)<0,"A target below the feet needs no stand");
        check(HuntPillar.levels(64,64+2.7f)<=HuntPillar.MAX&&HuntPillar.levels(64,64+12)>HuntPillar.MAX,"A giant is taller than the stand allows");

        // Which golems: only the village's own.
        check(GuardCombat.wildGolem(false,false,false),"A village-spawned golem is wild");
        check(!GuardCombat.wildGolem(true,false,false),"A player-built golem stays protected");
        check(!GuardCombat.wildGolem(false,true,false),"A named golem stays protected");
        check(!GuardCombat.wildGolem(false,false,true),"A leashed golem stays protected");

        // The one swing: the hunted wild golem only, and nothing when no swing is in flight.
        UUID golem=UUID.randomUUID(),other=UUID.randomUUID();
        check(GuardCombat.huntLicensed(true,golem,golem),"The golem being swung at is let through");
        check(!GuardCombat.huntLicensed(true,golem,other),"Another golem is not");
        check(!GuardCombat.huntLicensed(true,golem,null),"No swing in flight, no licence");
        check(!GuardCombat.huntLicensed(false,golem,golem),"A protected victim that is not a wild golem is never let through");
        // Through the friendly-fire cancel itself: licensed swing at the wild golem passes, everything else is cancelled as before.
        check(!GuardCombat.blocksFriendlyFire(true,false,false,!GuardCombat.huntLicensed(true,golem,golem)),"The licensed swing is not cancelled");
        check(GuardCombat.blocksFriendlyFire(true,false,false,!GuardCombat.huntLicensed(false,golem,golem)),"A player-built or named golem is still cancelled");
        check(GuardCombat.blocksFriendlyFire(true,false,false,!GuardCombat.huntLicensed(true,golem,null)),"A wild golem outside a hunt swing is still cancelled");
        System.out.println("HuntPillarTest: "+checks+" checks passed");
    }
}
