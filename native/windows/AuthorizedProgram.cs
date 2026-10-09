using System;
namespace LaunchFlow.Native
{
    // GUI subsystem avoids flashing a console in the user's interactive session.
    // This protected task entry point accepts only a fixed authorization key + nonce.
    public static class AuthorizedProgram
    {
        [STAThread]
        public static int Main(string[] args)
        {
            if(args.Length==4 && args[0]=="--configure-autologon")return AutoLogonDialog.Run(args[1],args[2],args[3]);
            if(args.Length==4 && args[0]=="--close-workspace")return WorkspaceCloseElevation.Run(args[1],args[2],args[3]);
            return args.Length == 3 && args[0] == "--run-authorized"
                ? TaskAuthorization.RunElevated(args[1], args[2]) : 11;
        }
    }
}
