using BabyMonitor.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BabyMonitor.Hubs;

/// <summary>Sunucu → istemci mesajları.</summary>
public interface IMonitorClient
{
    Task ViewerJoined(string viewerId);
    Task ViewerLeft(string viewerId);
    Task BroadcasterLeft();
    Task RoomFull();
    Task ReceiveOffer(string broadcasterId, string sdp);
    Task ReceiveAnswer(string viewerId, string sdp);
    Task ReceiveIce(string fromId, string candidate);
}

/// <summary>
/// Sadece WebRTC signaling (SDP + ICE) taşır; medya bu hub'dan geçmez.
/// PIN çerezi olmayan istemci bağlanamaz.
/// </summary>
[Authorize]
public sealed class MonitorHub : Hub<IMonitorClient>
{
    private readonly RoomState _room;
    private readonly ILogger<MonitorHub> _logger;

    public MonitorHub(RoomState room, ILogger<MonitorHub> logger)
    {
        _room = room;
        _logger = logger;
    }

    /// <returns>Kabul edildiyse true; başka yayıncı varsa false.</returns>
    public async Task<bool> JoinAsBroadcaster()
    {
        var id = Context.ConnectionId;
        var result = _room.JoinAsBroadcaster(id, out var waitingViewerIds);
        _logger.LogInformation("JoinAsBroadcaster {ConnectionId}: {Result}", id, result);

        if (result == JoinResult.Joined)
        {
            // Yayıncıdan önce gelip bekleyen izleyiciler için bağlantı kurulumu başlasın.
            foreach (var viewerId in waitingViewerIds)
                await Clients.Caller.ViewerJoined(viewerId);
        }

        return result is JoinResult.Joined or JoinResult.AlreadyJoined;
    }

    /// <returns>Kabul edildiyse true; oda doluysa RoomFull gönderilir ve false döner.</returns>
    public async Task<bool> JoinAsViewer()
    {
        var id = Context.ConnectionId;
        var result = _room.JoinAsViewer(id, out var broadcasterId);
        _logger.LogInformation("JoinAsViewer {ConnectionId}: {Result}", id, result);

        switch (result)
        {
            case JoinResult.Joined:
                if (broadcasterId is not null)
                    await Clients.Client(broadcasterId).ViewerJoined(id);
                return true;
            case JoinResult.AlreadyJoined:
                return true;
            case JoinResult.Rejected:
                await Clients.Caller.RoomFull();
                return false;
            default:
                return false;
        }
    }

    public async Task SendOffer(string viewerId, string sdp)
    {
        var id = Context.ConnectionId;
        if (_room.GetRole(id) != RoomRole.Broadcaster || !_room.CanSignal(id, viewerId))
            return;

        await Clients.Client(viewerId).ReceiveOffer(id, sdp);
    }

    public async Task SendAnswer(string sdp)
    {
        var id = Context.ConnectionId;
        var broadcasterId = _room.GetBroadcasterId();
        if (broadcasterId is null || !_room.CanSignal(id, broadcasterId))
            return;

        await Clients.Client(broadcasterId).ReceiveAnswer(id, sdp);
    }

    public async Task SendIce(string targetId, string candidate)
    {
        var id = Context.ConnectionId;
        if (!_room.CanSignal(id, targetId))
            return;

        await Clients.Client(targetId).ReceiveIce(id, candidate);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var id = Context.ConnectionId;
        var left = _room.Leave(id);

        switch (left.Role)
        {
            case RoomRole.Viewer:
                _logger.LogInformation("İzleyici ayrıldı: {ConnectionId}", id);
                if (left.BroadcasterId is not null)
                    await Clients.Client(left.BroadcasterId).ViewerLeft(id);
                break;
            case RoomRole.Broadcaster:
                _logger.LogInformation("Yayıncı ayrıldı: {ConnectionId}", id);
                if (left.ViewerIds.Count > 0)
                    await Clients.Clients(left.ViewerIds).BroadcasterLeft();
                break;
        }

        await base.OnDisconnectedAsync(exception);
    }
}
