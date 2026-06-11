import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
export default {
  name:"dice",aliases:["roll"],
  description:"Guess a die roll. `&dice <bet> <1-6>`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,bet=parseInt(args[0]),guess=parseInt(args[1]),u=await db.getUser(uid);
    if(isNaN(bet)||bet<=0||isNaN(guess)||guess<1||guess>6)return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}dice <bet> <1-6>\``)]});
    if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
    if(bet>250000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 250,000 FC.")]});
    const roll=Math.ceil(Math.random()*6);
    if(roll===guess){const win=Math.floor(bet*1.88);await db.updateBalance(uid,win);await db.recordGame(uid,true,bet+win);return message.channel.send({embeds:[embed(COLORS.primary).setTitle("🎲 WIN!").setDescription(`Rolled **${roll}** — you guessed it!\n+**${win.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
    else{await db.updateBalance(uid,-bet);await db.recordGame(uid,false,bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle("🎲 MISS").setDescription(`Rolled **${roll}**, you guessed **${guess}**.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
  }
};
