package com.mcbot.servercontrol;

import net.minecraft.core.Direction;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** The click geometry of build without a world: spots on a face, and the way of looking at them. */
final class BuildTaskTest {
    private static int checks;
    private static void check(boolean condition,String message){checks++;if(!condition)throw new AssertionError(message);}
    static void run() {
        AABB block=new AABB(0,64,0,1,65,1),slab=new AABB(0,64,0,1,64.5,1);
        for(Direction face:Direction.values()) {
            var points=BuildTask.facePoints(block,face);
            check(points.size()==9,face+": nine spots");
            check(points.getFirst().equals(new AABB(0,64,0,1,65,1).getCenter().add(face.getStepX()*0.5,face.getStepY()*0.5,face.getStepZ()*0.5)),face+": the centre of the face first");
            for(Vec3 p:points) {
                double along=face.getAxis().choose(p.x,p.y,p.z),edge=face.getAxisDirection()==Direction.AxisDirection.POSITIVE?block.max(face.getAxis()):block.min(face.getAxis());
                check(Math.abs(along-edge)<1e-9,face+": every spot lies on the face");
                check(p.x>=0&&p.x<=1&&p.y>=64&&p.y<=65&&p.z>=0&&p.z<=1,face+": inside the face");
            }
        }
        // A side face of a slab: the spots stay on the half block, upper spots above its middle (top-half stairs need those).
        var side=BuildTask.facePoints(slab,Direction.NORTH);
        check(side.stream().allMatch(p->p.y>=64&&p.y<=64.5),"Slab side spots stay on the slab");
        check(side.stream().anyMatch(p->p.y>64.25)&&side.stream().anyMatch(p->p.y<64.25),"Spots both above and below the middle of a side");
        // Looking the way the game measures it: +z is south (yaw 0), -x is east... yaw 90 is west, pitch down is positive.
        check(Math.abs(BuildTask.yaw(new Vec3(0,0,1)))<1e-6,"Looking south is yaw 0");
        check(Math.abs(BuildTask.yaw(new Vec3(-1,0,0))-90)<1e-6,"Looking west is yaw 90");
        check(Math.abs(Math.abs(BuildTask.yaw(new Vec3(0,0,-1)))-180)<1e-6,"Looking north is yaw 180");
        check(Math.abs(BuildTask.yaw(new Vec3(1,0,0))+90)<1e-6,"Looking east is yaw -90");
        check(BuildTask.pitch(new Vec3(1,-1,0))>44&&BuildTask.pitch(new Vec3(1,-1,0))<46,"Looking down is a positive pitch");
        check(BuildTask.AUTO.contains("shape")&&BuildTask.AUTO.contains("waterlogged")&&!BuildTask.AUTO.contains("facing")&&!BuildTask.AUTO.contains("half")&&!BuildTask.AUTO.contains("axis")&&!BuildTask.AUTO.contains("hinge"),
            "Neighbour-decided properties are not compared; facing, half, axis and hinge are");
        check(BuildTask.IMPLIED.containsAll(java.util.List.of("axis","half","type"))&&!BuildTask.IMPLIED.contains("facing")&&!BuildTask.IMPLIED.contains("hinge"),
            "Axis, half and type left out still take the default and are compared; facing and hinge only when given");
        check(BuildTask.IMPLIED.stream().noneMatch(BuildTask.AUTO::contains),"Nothing implied is also neighbour-decided");
        System.out.println("BuildTaskTest: "+checks+" checks passed (click geometry only; placement in a world not tested)");
    }
}
