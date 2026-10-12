package com.mcbot.servercontrol;

import java.util.*;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import static com.mcbot.servercontrol.Protocol.*;

/**
 * Which blocks may be somebody's building, without a game: the three reasons (village piece, a bed/door/container within
 * reach, the remembered home), the body's own placed blocks, the home in a request, a scan leaving candidates out and
 * counting them, and the options of a scan. The level is a fake World; Live (structure and block entity queries) needs a
 * running game and is covered by the isolated-server smoke.
 */
final class BuildingGuardTest {
    private static int checks;
    private static void check(boolean ok,String message){checks++;if(!ok)throw new AssertionError(message);}

    /** A village over x 100..110, and dwellings at the given cells. */
    private static BuildingGuard.World world(BlockPos... dwellings) {
        Set<BlockPos> homes=Set.of(dwellings);
        return new BuildingGuard.World() {
            public boolean villagePiece(BlockPos pos){return pos.getX()>=100&&pos.getX()<=110;}
            public boolean dwelling(BlockPos pos){return homes.contains(pos);}
        };
    }
    private static final double NEAR=4.5; // the body's block interaction range (the game's default)
    private static final Predicate<BlockPos> NONE=p->false;

    static void run() {
        BlockPos chest=new BlockPos(0,64,0);
        BuildingGuard guard=BuildingGuard.around(world(chest),NEAR,null,NONE,new BlockPos(-10,60,-10),new BlockPos(10,70,10));
        // a. village piece
        BuildingGuard village=BuildingGuard.around(world(),NEAR,null,NONE,new BlockPos(100,60,0),new BlockPos(110,70,0));
        check(village.reason(new BlockPos(105,64,0))==BuildingGuard.Reason.VILLAGE,"inside a village piece: village");
        check(village.reason(new BlockPos(111,64,0))==null,"outside every piece (the fields around count for nothing): no reason");
        // b. lived in: a block within reach of a chest, the chest itself, not beyond reach
        check(guard.reason(chest)==BuildingGuard.Reason.LIVED_IN,"the chest itself");
        check(guard.reason(new BlockPos(3,64,0))==BuildingGuard.Reason.LIVED_IN,"three blocks from the chest");
        check(guard.reason(new BlockPos(0,67,3))==BuildingGuard.Reason.LIVED_IN,"diagonally above, still within reach (distance of block centres 4.24)");
        check(guard.reason(new BlockPos(4,64,3))==null,"centres 5 apart: out of reach");
        check(guard.reason(new BlockPos(0,70,0))==null,"six blocks above: out of reach");
        // dwellings found a reach outside the scanned box still protect its edge
        BuildingGuard edge=BuildingGuard.around(world(new BlockPos(4,64,0)),NEAR,null,NONE,new BlockPos(0,64,0),new BlockPos(0,64,0));
        check(edge.reason(new BlockPos(0,64,0))==BuildingGuard.Reason.LIVED_IN,"a door four cells outside the box still reaches its edge");
        // c. home
        BuildingGuard.Home home=new BuildingGuard.Home(50.5,64,50.5);
        BuildingGuard homed=BuildingGuard.around(world(),NEAR,home,NONE,new BlockPos(40,60,40),new BlockPos(60,70,60));
        check(homed.reason(new BlockPos(52,64,50))==BuildingGuard.Reason.HOME,"near the remembered home");
        check(homed.reason(new BlockPos(56,64,50))==null,"six blocks from home");
        check(BuildingGuard.around(world(),NEAR,null,NONE,new BlockPos(40,60,40),new BlockPos(60,70,60)).reason(new BlockPos(52,64,50))==null,"no home sent: nothing near home");
        // order of reasons: village first, then lived in, then home
        BuildingGuard all=BuildingGuard.around(world(new BlockPos(105,64,0)),NEAR,new BuildingGuard.Home(105.5,64,0.5),NONE,new BlockPos(105,64,0),new BlockPos(105,64,0));
        check(all.reason(new BlockPos(105,64,0))==BuildingGuard.Reason.VILLAGE,"village is named before the others");
        // exemption: the body's own pillar is never reported, wherever it stands
        OwnBlocks own=new OwnBlocks();
        own.add("minecraft:overworld",new BlockPos(105,64,0));own.add("minecraft:overworld",new BlockPos(1,64,0));own.add("minecraft:overworld",new BlockPos(52,64,50));
        Predicate<BlockPos> mine=p->own.has("minecraft:overworld",p);
        check(BuildingGuard.around(world(),NEAR,null,mine,new BlockPos(100,60,0),new BlockPos(110,70,0)).reason(new BlockPos(105,64,0))==null,"own block in a village");
        check(BuildingGuard.around(world(chest),NEAR,null,mine,new BlockPos(-10,60,-10),new BlockPos(10,70,10)).reason(new BlockPos(1,64,0))==null,"own block beside a chest");
        check(BuildingGuard.around(world(),NEAR,home,mine,new BlockPos(40,60,40),new BlockPos(60,70,60)).reason(new BlockPos(52,64,50))==null,"own block at home");
        check(BuildingGuard.around(world(chest),NEAR,null,mine,new BlockPos(-10,60,-10),new BlockPos(10,70,10)).reason(new BlockPos(2,64,0))==BuildingGuard.Reason.LIVED_IN,"the block beside it is still the chest's");
        check(!own.has("minecraft:the_nether",new BlockPos(1,64,0)),"own blocks are per dimension");
        own.remove("minecraft:overworld",new BlockPos(1,64,0));
        check(!own.has("minecraft:overworld",new BlockPos(1,64,0))&&own.size()==2,"a block dug out is forgotten");
        OwnBlocks later=new OwnBlocks();later.adopt(own);
        check(later.has("minecraft:overworld",new BlockPos(105,64,0)),"a respawn keeps the record");

        // the home of a request: only in this dimension
        var request=obj("home",obj("dimension","minecraft:overworld","x",50.5,"y",64.0,"z",50.5));
        check(BuildingGuard.home(request,"minecraft:overworld").equals(home),"home read from the request");
        check(BuildingGuard.home(request,"minecraft:the_nether")==null,"a home in another dimension means nothing here");
        check(BuildingGuard.home(obj(),"minecraft:overworld")==null,"no home in the request");

        // a scan leaves the possible buildings out and counts them; the rest keep their order
        List<BlockPos> candidates=new ArrayList<>(List.of(new BlockPos(105,64,0),new BlockPos(2,64,0),new BlockPos(52,64,50),new BlockPos(30,64,30),new BlockPos(1,64,0)));
        Set<BlockPos> ownScan=Set.of(new BlockPos(1,64,0));
        int left=BuildingGuard.leaveOut(candidates,p->p,world(chest),NEAR,home,ownScan::contains);
        check(left==3&&candidates.equals(List.of(new BlockPos(30,64,30),new BlockPos(1,64,0))),"village, chest and home candidates left out (3), the free one and the own one stay: "+candidates);
        List<BlockPos> clean=new ArrayList<>(List.of(new BlockPos(30,64,30)));
        check(BuildingGuard.leaveOut(clean,p->p,world(chest),NEAR,home,NONE)==0&&clean.size()==1,"nothing near: nothing counted");
        check(BuildingGuard.leaveOut(new ArrayList<BlockPos>(),p->p,world(chest),NEAR,home,NONE)==0,"an empty scan");

        // the scan option: includeBuildings is the caller's decision, never for companion mining
        var vec=new net.minecraft.world.phys.Vec3(0,64,0);
        check(!NearbyResources.options(obj("blockIds",List.of("minecraft:stone")),vec).includeBuildings(),"buildings are left out by default");
        check(NearbyResources.options(obj("blockIds",List.of("minecraft:stone"),"includeBuildings",true),vec).includeBuildings(),"includeBuildings:true keeps them in the scan");
        try{NearbyResources.options(obj("blockIds",List.of("#c:ores"),"includeBuildings",true,"companionMiningGuard",obj("player","Alex","expectedEntityId","00000000-0000-0000-0000-000000000001","maxDistance",4)),vec);check(false,"companion mining may not include buildings");}
        catch(Protocol.Error failure){check(failure.code.equals("INVALID_ARGUMENT"),"companion mining with includeBuildings is refused: "+failure.code);}
        System.out.println("BuildingGuardTest: "+checks+" checks passed");
    }
}
