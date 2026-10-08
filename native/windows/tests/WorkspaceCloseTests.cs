using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
public class WorkspaceCloseTests {
    static Dictionary<string,object> Obj(params object[] values) {
        var r=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)r[(string)values[i]]=values[i+1];return r;
    }
    static void Check(bool value,string message){if(!value)throw new Exception(message);}
    public static void Main(string[] args) {
        var assembly=Assembly.LoadFrom(args[0]);
        var method=assembly.GetType("LaunchFlow.Native.WorkspaceClose").GetMethod("CompleteAuthorization",BindingFlags.Static|BindingFlags.NonPublic);
        int calls=0;
        var targetA=Obj("pid",100,"handles",new[]{"1","2"});
        var targetB=Obj("pid",200,"handles",new[]{"3","4"});
        var denied=Obj("pid",200,"handles",new[]{"4"});
        var request=Obj("op","workspaceClose","action","graceful","ownerPid",999,"targets",new[]{targetA,targetB});
        var rows=new List<Dictionary<string,object>>{Obj("pid",100,"state","pending"),Obj("pid",200,"state","failed","permissionRequired",true,"retryTarget",denied)};
        Func<Dictionary<string,object>,object> authorize=(r)=>{
            calls++;Check((string)r["action"]=="graceful","Must not escalate to force");
            var targets=(object[])r["targets"];Check(targets.Length==1 && Object.ReferenceEquals(targets[0],denied),"Only denied original windows may be retried");
            return new[]{Obj("pid",200,"state","pending","message","sent")};
        };
        var result=(List<Dictionary<string,object>>)method.Invoke(null,new object[]{request,rows,authorize});
        Check(calls==1 && (string)result[0]["state"]=="pending" && (string)result[1]["state"]=="pending","Batched graceful authorization result");
        Check(result.All(r=>!r.ContainsKey("permissionRequired") && !r.ContainsKey("retryTarget")),"Do not leak internal retry targets");
        method.Invoke(null,new object[]{request,result,authorize});Check(calls==1,"Do not elevate successful operations");
        request["action"]="status";
        rows=new List<Dictionary<string,object>>{Obj("pid",100,"state","closed"),Obj("pid",200,"state","failed","permissionRequired",true)};
        method.Invoke(null,new object[]{request,rows,authorize});Check(calls==1,"Status must never request UAC");
        request["action"]="graceful";
        rows=new List<Dictionary<string,object>>{Obj("pid",100,"state","closed"),Obj("pid",200,"state","failed","permissionRequired",true)};
        Func<Dictionary<string,object>,object> cancel=(r)=>{throw (Exception)Activator.CreateInstance(assembly.GetType("LaunchFlow.Native.NativeFailure"),"uacCancelled","cancelled-fixture");};
        result=(List<Dictionary<string,object>>)method.Invoke(null,new object[]{request,rows,cancel});
        Check((string)result[0]["state"]=="closed" && (string)result[1]["state"]=="failed" && (string)result[1]["message"]=="cancelled-fixture","Cancellation keeps prior results and cannot force");
        var run=assembly.GetType("LaunchFlow.Native.WorkspaceCloseElevation").GetMethod("Run");
        Check((int)run.Invoke(null,new object[]{"untrusted-pipe","0","0"})==11,"Reject invalid helper entry");
        Console.WriteLine("PASS 6 administrator-close routing and input checks (no UAC invoked)");
    }
}
