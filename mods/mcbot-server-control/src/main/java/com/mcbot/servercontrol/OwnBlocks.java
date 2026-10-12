package com.mcbot.servercontrol;

import java.util.HashSet;
import java.util.Set;
import net.minecraft.core.BlockPos;

/**
 * Blocks the body placed itself in this hosting (a pillar it climbed, a block from place-block), kept in memory only:
 * BuildingGuard never reports them, so the body can dig its own pillar down again. Gone with the hosting; a block dug
 * out is forgotten, so whatever is placed there later by somebody else counts as theirs.
 */
final class OwnBlocks {
    private final Set<String> placed=new HashSet<>();
    private static String key(String dimension,BlockPos pos){return dimension+"/"+pos.asLong();}
    void add(String dimension,BlockPos pos){placed.add(key(dimension,pos));}
    boolean has(String dimension,BlockPos pos){return placed.contains(key(dimension,pos));}
    void remove(String dimension,BlockPos pos){placed.remove(key(dimension,pos));}
    /** After a respawn the new actions object keeps the record of the old one. */
    void adopt(OwnBlocks other){placed.addAll(other.placed);}
    int size(){return placed.size();}
}
