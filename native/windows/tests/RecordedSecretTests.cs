using System;
using LaunchFlow.Native;
class RecordedSecretTests
{
    static void Check(bool condition, string message) {if(!condition) throw new Exception(message);Console.WriteLine("PASS "+message);}
    static void Main()
    {
        var source = Wire.Obj("window", Wire.Obj("application","QQ.exe","title","QQ","className","Chrome_WidgetWin_1"),
            "role","Edit","name","MUST_NOT_PERSIST","className","Edit","frameworkId","Win32","secure",true,
            "ancestorPath",new[]{Wire.Obj("role","Window","name","Mutable name","className","Chrome_WidgetWin_1")});
        var locator=Sessions.Locator(source);
        Check(Wire.Bool(locator,"secure"),"Recorded password locators require a secure field");
        Check(Wire.Str(locator,"className")=="" && Wire.Str(locator,"frameworkId")=="","Chromium password proxy implementation is not persisted");
        Check(!Wire.Json.Serialize(locator).Contains("MUST_NOT_PERSIST") && !Wire.Json.Serialize(locator).Contains("Mutable name"),"Password and mutable ancestor names are absent");
        source["automationId"]="stable-password";
        locator=Sessions.Locator(source);
        Check(Wire.Str(locator,"automationId")=="stable-password" && Wire.Str(locator,"className")=="Edit","Stable explicit password IDs retain their constraints");
        source["secure"]=false;source["automationId"]="";
        locator=Sessions.Locator(source);
        Check(!Wire.Bool(locator,"secure") && Wire.Str(locator,"className")=="Edit","Ordinary input fields retain their provider constraints");
    }
}
