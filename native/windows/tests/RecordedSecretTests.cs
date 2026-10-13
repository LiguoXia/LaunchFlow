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
        var chrome = Wire.Obj("role", "Edit", "frameworkId", "Chrome", "automationId", "_r_g9_",
            "className", "ProseMirror ProseMirror-focused ProseMirror-hideselection", "secure", true);
        var stable = Desktop.StableAttributes(chrome);
        Check(Wire.Str(stable,"automationId")=="" && Wire.Str(stable,"className")=="ProseMirror",
            "Chromium render IDs and editor focus/selection state are not persistent selectors");
        Check(Wire.Bool(stable,"secure") && Wire.Str(stable,"role")=="Edit" && Wire.Str(stable,"frameworkId")=="Chrome",
            "Stable normalization preserves role, provider and password constraints");
        Check(Wire.Str(chrome,"automationId")=="_r_g9_" && Wire.Str(chrome,"className").Contains("focused"),
            "Normalizing a locator does not mutate the stored scene");
        chrome["automationId"] = ":r12:";
        Check(Wire.Str(Desktop.StableAttributes(chrome),"automationId")=="", "Legacy React useId format is normalized");
        chrome["automationId"] = "composer-input";
        Check(Wire.Str(Desktop.StableAttributes(chrome),"automationId")=="composer-input", "Explicit stable IDs remain mandatory");
        chrome["automationId"] = "_r_g9_"; chrome["frameworkId"] = "WPF";
        Check(Wire.Str(Desktop.StableAttributes(chrome),"automationId")=="_r_g9_" && Wire.Str(Desktop.StableAttributes(chrome),"className").Contains("focused"),
            "Chromium normalization does not relax other UI frameworks");
    }
}
