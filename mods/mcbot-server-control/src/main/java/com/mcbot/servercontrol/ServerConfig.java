package com.mcbot.servercontrol;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.UUID;
import static com.mcbot.servercontrol.Protocol.*;

record ServerConfig(String worldId,String username,UUID uuid,int port,Double spawnX,Double spawnY,Double spawnZ) {
    /** A new single-player config defaults to an auto world ID (see HostingRules.worldId); a new dedicated one gets HostingRules.newServerWorldId. */
    static ServerConfig load(Path directory,boolean dedicated) throws IOException {
        Files.createDirectories(directory);
        Path path=directory.resolve("server.json");
        if(!Files.exists(path)) Files.writeString(path,JSON.toJson(obj("worldId",dedicated?HostingRules.newServerWorldId():HostingRules.AUTO_WORLD,"username","Claude","uuid","9c6882e0-e80c-4c3e-8f20-8e3f42c738a1","port",8766,"spawn",null)),StandardCharsets.UTF_8);
        JsonObject json=com.google.gson.JsonParser.parseString(Files.readString(path,StandardCharsets.UTF_8)).getAsJsonObject();
        String world=string(json,"worldId"), name=string(json,"username");
        if(!name.matches("[A-Za-z0-9_]{1,16}")) throw error("INVALID_ARGUMENT","Invalid configured username");
        UUID uuid=UUID.fromString(string(json,"uuid"));
        double configuredPort=bounded(json,"port",8766,1024,65535);
        if(configuredPort!=Math.rint(configuredPort)) throw error("INVALID_ARGUMENT","port must be integral");
        Double x=null,y=null,z=null;
        if(json.has("spawn")&&!json.get("spawn").isJsonNull()) {
            JsonObject spawn=object(json,"spawn");
            x=bounded(spawn,"x",0,-29_999_000,29_999_000); y=bounded(spawn,"y",64,-64,1000); z=bounded(spawn,"z",0,-29_999_000,29_999_000);
        }
        return new ServerConfig(world,name,uuid,(int)configuredPort,x,y,z);
    }
    ServerConfig withWorldId(String id){return new ServerConfig(id,username,uuid,port,spawnX,spawnY,spawnZ);}
}
